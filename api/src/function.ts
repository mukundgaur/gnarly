import { onRequest } from 'firebase-functions/v2/https';
import { createFirebaseDeps } from './firebaseBackend.ts';
import { createHandler } from './http.ts';

const handler = createHandler(createFirebaseDeps());

/** Cloud Functions (2nd gen, Cloud Run) entry. The same handler serves Cloud Run via src/main.ts. */
export const api = onRequest({
  region: 'us-central1',
  memory: '1GiB',
  timeoutSeconds: 300,
  cors: false,
  invoker: 'public',
}, (req, res) => {
  void handler(req, res);
});
