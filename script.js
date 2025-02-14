mapboxgl.accessToken = 'pk.eyJ1IjoiYWtzaGF5Nzg5MCIsImEiOiJjbDVjc2pmYWcwNDFsM2ZtcDBkeDBwYTdsIn0.MU3n8CPKOZeh1KvS7TiYFQ';


const truckLocation = [77.33472, 28.54695];
const warehouseLocation = [77.33472, 28.54695];
const lastAtRestaurant = 0;
let keepTrack = [];
const pointHopper = {};


// Initialize a map
const map = new mapboxgl.Map({
    container: 'map', // container id
    style: 'mapbox://styles/mapbox/streets-v11', // stylesheet location
    center: truckLocation, // starting position
    zoom: 15 // starting zoom
});

var directions = new MapboxDirections({
    accessToken: mapboxgl.accessToken,
    unit: 'metric',
  });
  map.addControl(directions, 'top-left');

// Add the control to the map.
map.addControl(
    new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl: mapboxgl
    })
);


map.addControl(new mapboxgl.NavigationControl());

const warehouse = turf.featureCollection([turf.point(warehouseLocation)]);

// Create an empty GeoJSON feature collection for drop off locations
const dropoffs = turf.featureCollection([]);

// Create an empty GeoJSON feature collection, which will be used as the data source for the route before users add any new data
const nothing = turf.featureCollection([]);

map.on('load', async () => {
    const marker = document.createElement('div');
    marker.classList = 'truck';

    // Create a new marker
    new mapboxgl.Marker(marker).setLngLat(truckLocation).addTo(map);

    // Create a circle layer
    map.addLayer({
        id: 'warehouse',
        type: 'circle',
        source: {
            data: warehouse,
            type: 'geojson'
        },
        paint: {
            'circle-radius': 20,
            'circle-color': 'white',
            'circle-stroke-color': '#3887be',
            'circle-stroke-width': 3
        }
    });

    // Create a symbol layer on top of circle layer
    map.addLayer({
        id: 'warehouse-symbol',
        type: 'symbol',
        source: {
            data: warehouse,
            type: 'geojson'
        },
        layout: {
            'icon-image': 'grocery-15',
            'icon-size': 1
        },
        paint: {
            'text-color': '#3887be'
        }
    });

    map.addLayer({
        id: 'dropoffs-symbol',
        type: 'symbol',
        source: {
            data: dropoffs,
            type: 'geojson'
        },
        layout: {
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-image': 'marker-15'
        }
    });

    map.addSource('route', {
        type: 'geojson',
        data: nothing
    });

    map.addLayer(
        {
            id: 'routeline-active',
            type: 'line',
            source: 'route',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#3887be',
                'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 22, 12]
            }
        },
        'waterway-label'
    );

    map.addLayer(
        {
            id: 'routearrows',
            type: 'symbol',
            source: 'route',
            layout: {
                'symbol-placement': 'line',
                'text-field': '▶',
                'text-size': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12,
                    24,
                    22,
                    60
                ],
                'symbol-spacing': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    12,
                    30,
                    22,
                    160
                ],
                'text-keep-upright': false
            },
            paint: {
                'text-color': '#3887be',
                'text-halo-color': 'hsl(55, 11%, 96%)',
                'text-halo-width': 3
            }
        },
        'waterway-label'
    );

    // Listen for a click on the map
    await map.on('click', addWaypoints);
});

async function addWaypoints(event) {
    // When the map is clicked, add a new drop off point
    // and update the `dropoffs-symbol` layer
    await newDropoff(map.unproject(event.point));
    updateDropoffs(dropoffs);
}

async function newDropoff(coordinates) {
    // Store the clicked point as a new GeoJSON feature with
    // two properties: `orderTime` and `key`
    const pt = turf.point([coordinates.lng, coordinates.lat], {
        orderTime: Date.now(),
        key: Math.random()
    });
    dropoffs.features.push(pt);
    pointHopper[pt.properties.key] = pt;

    // Make a request to the Optimization API
    const query = await fetch(assembleQueryURL(), { method: 'GET' });
    const response = await query.json();

    // Create an alert for any requests that return an error
    if (response.code !== 'Ok') {
        const handleMessage =
            response.code === 'InvalidInput'
                ? 'Refresh to start a new route. For more information: https://docs.mapbox.com/api/navigation/optimization/#optimization-api-errors'
                : 'Try a different point.';
        alert(`${response.code} - ${response.message}\n\n${handleMessage}`);
        // Remove invalid point
        dropoffs.features.pop();
        delete pointHopper[pt.properties.key];
        return;
    }

    // Create a GeoJSON feature collection
    const routeGeoJSON = turf.featureCollection([
        turf.feature(response.trips[0].geometry)
    ]);

    // Update the `route` source by getting the route source
    // and setting the data equal to routeGeoJSON
    map.getSource('route').setData(routeGeoJSON);
}

function updateDropoffs(geojson) {
    map.getSource('dropoffs-symbol').setData(geojson);
}

// Here you'll specify all the parameters necessary for requesting a response from the Optimization API
function assembleQueryURL() {
    // Store the location of the truck in a variable called coordinates
    const coordinates = [truckLocation];
    const distributions = [];
    let restaurantIndex;
    keepTrack = [truckLocation];

    // Create an array of GeoJSON feature collections for each point
    const restJobs = Object.keys(pointHopper).map(
        (key) => pointHopper[key]
    );

    // If there are actually orders from this restaurant
    if (restJobs.length > 0) {
        // Check to see if the request was made after visiting the restaurant
        const needToPickUp =
            restJobs.filter((d) => d.properties.orderTime > lastAtRestaurant)
                .length > 0;

        // If the request was made after picking up from the restaurant,
        // Add the restaurant as an additional stop
        if (needToPickUp) {
            restaurantIndex = coordinates.length;
            // Add the restaurant as a coordinate
            coordinates.push(warehouseLocation);
            // push the restaurant itself into the array
            keepTrack.push(pointHopper.warehouse);
        }

        for (const job of restJobs) {
            // Add dropoff to list
            keepTrack.push(job);
            coordinates.push(job.geometry.coordinates);
            // if order not yet picked up, add a reroute
            if (needToPickUp && job.properties.orderTime > lastAtRestaurant) {
                distributions.push(
                    `${restaurantIndex},${coordinates.length - 1}`
                );
            }
        }
    }

    // Set the profile to `driving`
    // Coordinates will include the current location of the truck,
    return `https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${coordinates.join(
        ';'
    )}?distributions=${distributions.join(
        ';'
    )}&overview=full&steps=true&geometries=geojson&source=first&access_token=${mapboxgl.accessToken
        }`;
}