# Gnarly web companion

Run locally:

```sh
cd web
npm install
npm run dev
```

For a built deployment with the same Storage download behavior, run `npm run build && npm start`. The Node server serves `dist/` and proxies downloads only from this project's configured Firebase Storage bucket. A static-only host would still need bucket CORS configured.

The site opens in a labeled sample mode centered on the Cornell area. The **North Hall** building, floor layout, destinations, and two-floor route are illustrative. Add `VITE_GOOGLE_MAPS_API_KEY` to `web/.env` to use Google Maps. Without it, OpenStreetMap remains available.

## Google Maps setup

1. In the Google Cloud project associated with Firebase, enable **Maps JavaScript API** and confirm billing is configured.
2. In **APIs & Services → Credentials**, create or select a browser API key. Restrict it to **Websites** (`http://localhost:5173/*` for local development and your deployed domain later) and to **Maps JavaScript API**.
3. In **Google Maps Platform → Map Management**, create a **JavaScript vector** map ID. Put the key and map ID in `web/.env` as `VITE_GOOGLE_MAPS_API_KEY` and `VITE_GOOGLE_MAPS_MAP_ID`.
4. Restart `npm run dev`. The map credit at bottom right should say **Google Maps**. If the map shows a Google error, check browser console, billing, key restrictions, and whether Maps JavaScript API is enabled.

Browser API keys are visible in the site bundle; HTTP referrer and API restrictions are the relevant protections. Do not use a service-account key here.

## Connect Firebase

1. In the **same existing Firebase project**, go to **Project settings → General → Your apps → Add app → Web**. Name it `Gnarly web`. Hosting setup is optional. Copy the public Firebase config object into `web/.env` using `.env.example` as a template. Never put a service-account key in this file.
2. Enable Email/Password sign-in for an existing authorized user. The repository rules require authentication for all reads. Use **Connect Firebase** in the website to sign in; credentials go directly to Firebase Auth.
3. A building document at `buildings/{id}` needs `name`, `status`, and `activeVersion`. To show it on the map, add a `location` GeoPoint or `latitude` and `longitude` fields. The current Swift `Building` model has no location fields, so existing records without them appear in search but cannot have a map marker.
4. The mapper now uploads each zone beneath `buildings/{id}/{activeVersion}/zones/{zoneId}/`. The web app reads zone documents at `buildings/{id}/versions/{activeVersion}/zones/{zoneId}` and their `buildingJsonPath` and `scanFeaturesPath` fields. It also supports the earlier version-level paths for older packages.

The waypoint editor reads and writes graph packages in Firebase Storage, then advances the Firestore zone pointer in a transaction. It does not change security rules. Buildings with missing active versions or package assets show an unavailable state. The current iOS export schema is zone-based; a true two-floor route requires a merged graph with stair edges and coordinates aligned between zones.

### Browser downloads and CORS

The website routes Storage downloads through its same-origin server, so local development and `npm start` work without changing bucket CORS. The current `main-building` active version `v1` has readable graphs in zones `1`, `2`, and `zone-a`, but none of those zones has `scan-features.json` or `scan.json` at its declared/fallback path. The viewer therefore shows the navigation graph and a missing-scan notice. The mapper must upload the missing RoomPlan files before the site can draw actual walls for that version.

If the site is deployed as static files without the Node server, the bucket owner should inspect existing CORS rules and add the deployed origin with `GET`. A local sample rule is in `firebase/cors.web.local.json`. For a bucket with no other CORS needs, they can apply it from the repository root with:

```sh
gcloud storage buckets update gs://gnarly-e65c1.firebasestorage.app --cors-file=firebase/cors.web.local.json
```

The update replaces the bucket's CORS configuration, so merge this rule with any existing rules first. Add the deployed website origin before deployment. Keep Firebase Storage read rules authenticated as they are; CORS only controls which browser origins can request the files.

## Firebase data workspace

Use **Firebase data** in the site header after signing in. It lists building documents, versions, floors, zones, destinations, nodes, and edges in Firestore. Select a document to inspect its JSON. The account named as admin in `firebase/firestore.rules` can edit existing documents: change the JSON, review changed or removed top-level fields, then save. Saves use a Firestore transaction and reject stale data if another edit occurred meanwhile. Signed-in non-admin accounts can browse without editing. The workspace can also preview JSON files linked by a zone's `buildingJsonPath`, `scanFeaturesPath`, or `scanJsonPath`; scan assets are read-only here, while the waypoint editor saves a new graph JSON package. Scan uploads still go through the mapper.

## 3D assets

The mapper exports `scan-features.json` alongside `structure.usdz`, `scan.json`, and `building.json` for each zone. The browser reads the zone's feature JSON and renders RoomPlan floors, walls, openings, doors, windows, and objects in ARKit world coordinates. For floors, it triangulates the captured `polygonCorners` in the floor’s local plane and applies the RoomPlan transform; scans without a polygon use a rectangular fallback. Door, opening, and window outlines cut holes in their parent walls; the original USDZ stays in Storage for iOS and later mesh conversion. A live zone without scan features shows its route graph only. The sample building's enclosing walls are illustrative. One scan covers only its captured room/zone; multi-floor routing requires aligned, connected graph data.

Build check: `npm run build`.

## Drop-to-walk view

In the building explorer, drag **Drop to walk** onto any visible floor. The viewer switches to that floor and places the camera at eye height. Drag inside the scene to look around, use WASD or the arrow keys to move, and hold Shift to move faster. The on-screen direction pad provides the same movement controls on touch devices. Choose **Exit** to return to the orbiting overview; the person marker remains at the last walk position and can be dragged somewhere else.

Walk mode stays inside the selected floor boundary. When `scan-features.json` is available, movement is also stopped by scanned walls and can cross them only through a captured door or opening. On graph-only packages, the generated floor bounds are used because wall geometry is not available.

## Waypoint editor and routing

Open a building and choose **Edit waypoints**. Select, add by clicking a floor, move by clicking a floor or entering XYZ meters, edit name/type/floor, connect two waypoints, or delete a waypoint and its incident edges. The site preserves existing waypoint IDs. Its coordinates are the package's ARKit world coordinates. An affected edge's `meters` is recalculated from 3D endpoint distance when a waypoint moves. The editor validates IDs, endpoints, floors, distances, floor surfaces, walls, and stair transitions before saving. Existing blocked connections are shown and excluded from routes; an unrelated edit may be saved, but newly blocked connections must be fixed. Cancel restores the last saved graph. A dirty draft survives refresh in browser storage and leaving prompts before navigation.

**Local test · browser only** is available without Firebase credentials. Its graph uses the same `GraphStore` interface as Firebase, saves in browser storage, and is always labeled **not synced**. The Firebase mode requires the authorized account from the existing rules. It writes an immutable `graph-edits/<uuid>.json` object in the zone's existing Storage folder, then atomically moves that zone's Firestore `buildingJsonPath` pointer if the pointer has not changed. Other open web clients reload through a Firestore listener and periodic check. A changed pointer while a local draft exists raises a conflict and keeps the draft. The previous graph object remains in Storage. The Unity navigator and mapper package download now accept that pointer path; installed iOS/Unity builds need rebuilding to pick up the change. The mapper can still publish another package and move the pointer again.

Firebase writes need the existing admin Auth UID and Storage/Firestore rules to allow writes. No rules were loosened. Bucket CORS for browser uploads also needs this site's origin and the upload methods (`POST` and `PUT`; the browser sends an `OPTIONS` preflight) alongside the existing read methods; inspect and merge the bucket's current CORS settings before applying anything. Firebase save and cross-client synchronization still require a live authorized check. A failed save retains the local draft and shows **Save failed**.

`src/routing.ts` is the algorithm handoff point. `findRoute({ graph, startId, destinationId, options: { scan } })` returns either `{ ok: true, nodes, edges, distance, floorTransitions, unverifiedEdges }` with ordered nodes and edges, or `{ ok: false, reason, message }` for invalid endpoints or no route. Example: `findRoute({ graph, startId: 'entrance', destinationId: 'stairs-top', options: { scan } })`. The current implementation is Dijkstra over `edge.meters`. It respects directed edges (`bidirectional: false`) and checks every candidate edge through `checkEdge()` in `src/geometry.ts`. A replacement algorithm should keep this contract and use only geometry-approved edges. The preview draws consecutive route edges, without smoothing.

Wall safety depends on `scan-features.json`: a connection must stay on scanned floor polygons and cross a wall only where a matched door or opening exists. Cross-floor edges must explicitly connect stair waypoints. Where scan features are missing, only `manual`, `recorded`, or `walked-path` edges are usable, and the UI labels them **unverified**. Such edges have no automatic wall guarantee; an operator must confirm them against the actual space. Other edges without scan data are blocked. If no approved graph path exists, the viewer says **No walkable route found.**

Run `node --experimental-strip-types --test src/routing.test.ts` from `web/` for the wall, doorway, corner, stairs, and edit checks.
