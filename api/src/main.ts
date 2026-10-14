import { createServer } from 'node:http';
import { createFirebaseDeps } from './firebaseBackend.ts';
import { createHandler } from './http.ts';

const handler = createHandler(createFirebaseDeps());
const port = Number(process.env.PORT || 8080);

createServer((req, res) => {
  void handler(req, res);
}).listen(port, () => {
  console.log(`Gnarly publish API listening on ${port}`);
});
