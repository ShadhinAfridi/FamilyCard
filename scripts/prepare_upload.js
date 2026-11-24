import fs from 'fs';

const minCode = fs.readFileSync('scripts/worker.min.js', 'utf8');
const escaped = JSON.stringify(minCode);
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

fs.writeFileSync('scripts/upload_code.js', fnCode, 'utf8');
fs.writeFileSync('scripts/tool_args.json', JSON.stringify({
  account_id: 'b15dad3a43d83af6b937c179e30f386d',
  code: fnCode
}), 'utf8');
console.log('Saved scripts/upload_code.js and scripts/tool_args.json. Size:', fnCode.length);
