import fs from 'fs';
import crypto from 'crypto';

function id() {
  return crypto.randomUUID();
}

const workflow = {
  name: 'model-card-project-dir',
  nodes: [
    {
      id: id(),
      name: '项目目录 Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 1,
      position: [0, 0],
      parameters: {
        httpMethod: 'POST',
        path: 'model-card-project-dir',
        responseMode: 'lastNode',
        options: {},
      },
    },
    {
      id: id(),
      name: '维护项目目录',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [280, 0],
      parameters: {
        language: 'javaScript',
        jsCode: `const fs = require('fs');
const path = require('path');

const input = $input.first().json;
const body = input.body || input;
const action = String(body.action || 'mkdir');
const projectName = String(body.projectName || '').trim();
const oldProjectName = String(body.oldProjectName || '').trim();

if (!projectName) {
  return [{ json: { success: false, error: 'projectName required' } }];
}

function clean(value) {
  return String(value).replace(/[\\\\/?:*<>|"]/g, '_').replace(/\\s+/g, '_') || 'unnamed';
}

const root = '/home/node/.n8n-files/model-card';
const dir = path.resolve(root, clean(projectName));
const oldDir = oldProjectName ? path.resolve(root, clean(oldProjectName)) : null;

if (!dir.startsWith(root + path.sep) || (oldDir && !oldDir.startsWith(root + path.sep))) {
  return [{ json: { success: false, error: 'unsafe path', dir } }];
}

if (action === 'rm') {
  fs.rmSync(dir, { recursive: true, force: true });
  return [{ json: { success: true, action, dir } }];
}

if (action === 'rename') {
  if (!oldDir) {
    return [{ json: { success: false, error: 'oldProjectName required for rename' } }];
  }
  if (oldDir !== dir && fs.existsSync(oldDir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) {
      fs.rmSync(oldDir, { recursive: true, force: true });
    } else {
      fs.renameSync(oldDir, dir);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  return [{ json: { success: true, action, dir, oldDir } }];
}

fs.mkdirSync(dir, { recursive: true });
return [{ json: { success: true, action: 'mkdir', dir } }];`,
      },
    },
  ],
  connections: {
    '项目目录 Webhook': {
      main: [[{ node: '维护项目目录', type: 'main', index: 0 }]],
    },
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Shanghai',
  },
};

fs.mkdirSync('n8n', { recursive: true });
fs.writeFileSync('n8n/model-card-project-dir-workflow.json', JSON.stringify(workflow, null, 2));
