# Firebase operations

## Web viewer CORS

`cors.web.local.json` allows the local Vite viewer at
`http://localhost:4173` or `http://localhost:5173` to download and upload
navigation assets in Cloud Storage.

Bucket CORS updates replace the whole CORS array. Inspect the current config
and merge the local viewer rule into it before applying:

```sh
gcloud storage buckets describe gs://gnarly-e65c1.firebasestorage.app \
  --format='json(cors_config)'

gcloud storage buckets update gs://gnarly-e65c1.firebasestorage.app \
  --cors-file=firebase/cors.web.local.json
```

If the bucket already has CORS entries, do not run the second command with the
repository file unchanged. Copy the existing entries into a temporary JSON
array, append the rule from `cors.web.local.json`, and apply that merged file.

Verify both the preflight and actual response before testing the viewer again:

```sh
curl -i -X OPTIONS \
  -H 'Origin: http://localhost:4173' \
  -H 'Access-Control-Request-Method: GET' \
  'https://firebasestorage.googleapis.com/v0/b/gnarly-e65c1.firebasestorage.app/o/OBJECT'
```
