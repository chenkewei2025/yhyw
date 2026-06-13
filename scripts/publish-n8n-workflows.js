import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const n8nApiBaseUrl = (process.env.N8N_API_BASE_URL || 'https://n8n.ccyinghe.com/api/v1').replace(/\/+$/, '');
const n8nApiKey = process.env.N8N_API_KEY || '';

if (!n8nApiKey) {
  throw new Error('缺少 N8N_API_KEY');
}

async function apiRequest(urlPath, options = {}) {
  const response = await fetch(`${n8nApiBaseUrl}${urlPath}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'X-N8N-API-KEY': n8nApiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${urlPath} 失败: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function listWorkflows() {
  const response = await apiRequest('/workflows?limit=100');
  return response.data || [];
}

async function upsertWorkflow(fileName, activate = true) {
  const workflowPath = path.resolve('n8n', fileName);
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const existing = (await listWorkflows()).find((item) => item.name === workflow.name);

  if (existing) {
    await apiRequest(`/workflows/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(workflow),
    });
    if (activate) {
      await apiRequest(`/workflows/${existing.id}/activate`, { method: 'POST' });
    }
    return { id: existing.id, name: workflow.name, action: 'updated' };
  }

  const created = await apiRequest('/workflows', {
    method: 'POST',
    body: JSON.stringify(workflow),
  });

  if (activate) {
    await apiRequest(`/workflows/${created.id}/activate`, { method: 'POST' });
  }

  return { id: created.id, name: workflow.name, action: 'created' };
}

const results = [];
results.push(await upsertWorkflow('model-card-workflow.json', true));
results.push(await upsertWorkflow('model-card-project-dir-workflow.json', true));

for (const result of results) {
  console.log(`${result.action}: ${result.name} (${result.id})`);
}
