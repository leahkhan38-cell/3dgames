# Flight Radar

A full-screen flight tracker using Leaflet, Esri World Imagery, and instanced Three.js aircraft models. The 3D planes follow live track angles and remain clickable on the map. The dashboard polls the OpenSky Network through a small same-origin Node endpoint, which avoids browser CORS restrictions.

## Run

```sh
node server.js
```

Open http://localhost:3000. Set `PORT` to use another port. No package installation is required.

The live feed depends on OpenSky availability and its current unauthenticated API limits. The radar reports connection errors rather than displaying simulated aircraft.