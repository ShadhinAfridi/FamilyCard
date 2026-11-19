import fs from 'fs';

const code = fs.readFileSync('cloudflare/worker.js', 'utf8');
const escaped = JSON.stringify(code);
const fnCode = `async () => {
  const workerCode = ${escaped};
  const metadata = { main_module: "worker.js", compatibility_date: "2024-09-23" };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");
  return cloudflare.request({
    method: "PUT",
    path: \`/accounts/\${accountId}/workers/scripts/familycard\`,
    body: form
  });
}`;

fs.writeFileSync('scripts/upload_code.js', fnCode);
console.log('Upload script saved. Length:', fnCode.length);
