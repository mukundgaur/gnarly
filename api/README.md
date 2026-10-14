# Publish API

Clients used to read and write Firebase directly. This service is the gate for list, download, and publish.

1. The caller sends a Firebase ID token.
2. The API checks the building ACL.
3. Publish, list, and download are rate-limited per user, per building, and per IP.
4. Publish uploads go to a new immutable version through short-lived signed URLs. `activeVersion` stays put.
5. Commit reads the objects back, checks required files, JSON schema, signatures, and size, then writes the version, zones, and `activeVersion` in one transaction.

A failed upload or a failed check leaves the previous active map in place. Zones already on that map are carried forward by path; their bytes are not rewritten.

## ACL

- `ownerUid`, an `acl` entry of `owner` or `editor`, or `GNARLY_ADMIN_UID` can publish.
- `visibility: "members"` limits download to owner, editor, viewer, and admin. Anything else allows any signed-in user to download a published map.
- Client Firestore writes cannot change `activeVersion`. Storage rules do not grant client reads or package writes; signed URLs bypass those rules.

## Run locally

```sh
cd api
npm install
npm test
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
  FIREBASE_STORAGE_BUCKET=gnarly-e65c1.firebasestorage.app \
  npm start
```

The service account needs Storage access and `roles/iam.serviceAccountTokenCreator` on itself so it can sign URLs without a downloaded key. On Cloud Run that is the runtime service account.

## Cloud Run

From the repository root:

```sh
gcloud run deploy gnarly-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars FIREBASE_STORAGE_BUCKET=gnarly-e65c1.firebasestorage.app,TRUST_PROXY=1,GNARLY_ADMIN_UID=WwvbXcl5hpQgdl8KO79JwcThYJd2
```

`--allow-unauthenticated` lets the apps reach the service. The handler still rejects requests that do not carry a Firebase ID token. The Dockerfile build context is the repository root (`docker build -f api/Dockerfile .`).

## Cloud Functions

```sh
cd api && npm ci && npm run build
firebase deploy --only functions,firestore:rules,storage
```

The function is `api` in `us-central1`. Rules deploy is what stops clients from moving `activeVersion` themselves.

## API Gateway

`gateway.yaml` is an OpenAPI spec for Google API Gateway in front of the Cloud Run URL. Replace `PROJECT_ID` and `CLOUD_RUN_HOST`. The service still verifies the Firebase token, so the gateway is an additional front door rather than the only check.

## Limits

Publish defaults to 10 per hour per user, 20 per building, and 30 per IP. List and download use one-minute windows (60/120/120 and 120/240/240). Override with `GNARLY_RATE_PUBLISH_USER` and the matching `BUILDING`, `IP`, and `WINDOW_MS` variables for `PUBLISH`, `LIST`, and `DOWNLOAD`.

Signed upload URLs last 15 minutes. Signed download URLs last 5 minutes. A publish session lasts 30 minutes. Enable a Firestore TTL on `rateLimits.expiresAt` so spent windows do not accumulate.

## Clients

- Mapper: `GnarlyApiBaseURL` in `mapper-ios/GnarlyMapper/Info.plist`. `http://127.0.0.1:8080` reaches a simulator. A device needs the deployed https origin.
- Navigator: put the same origin on its own line in `navigator-unity/Assets/Resources/gnarly-api-base.txt`.
- Web: `VITE_GNARLY_API_BASE` in `web/.env`. The site proxies signed `storage.googleapis.com` URLs through `/__signed`.
