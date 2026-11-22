Drop real flight tracks here (KML, CSV, GPX or GeoJSON), then run `scripts/build.sh route`
(and `basemap`, if the corridor moved). With no files here the route is the great circle.
Supported: FlightAware KML (gx:Track), FlightRadar24 KML/CSV, GPX, GeoJSON LineString with
`properties.times`, and the output of `pipeline/fetch_adsblol.py`.
