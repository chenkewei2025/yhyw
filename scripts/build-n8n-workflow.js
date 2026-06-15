import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';

const n8nApiBaseUrl = (process.env.N8N_API_BASE_URL || 'https://n8n.ccyinghe.com/api/v1').replace(/\/+$/, '');
const n8nApiKey = process.env.N8N_API_KEY || '';
const sourceWorkflowId = process.env.N8N_SOURCE_WORKFLOW_ID || '86o21cTCHceBCfE1';

function id() {
  return crypto.randomUUID();
}

function node(name, type, typeVersion, position, parameters, extra = {}) {
  return {
    id: id(),
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...extra,
  };
}

async function fetchSourceWorkflow() {
  if (fs.existsSync('/tmp/pptx_nodes.json')) {
    const exported = JSON.parse(fs.readFileSync('/tmp/pptx_nodes.json', 'utf8'));
    return Array.isArray(exported) ? exported[0] : exported;
  }

  if (!n8nApiKey) {
    throw new Error('缺少 N8N_API_KEY，且 /tmp/pptx_nodes.json 不存在');
  }

  const response = await fetch(`${n8nApiBaseUrl}/workflows/${sourceWorkflowId}`, {
    headers: {
      'X-N8N-API-KEY': n8nApiKey,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`拉取源工作流失败: HTTP ${response.status}`);
  }

  return response.json();
}

const prompt = `=分析{{ ($json.body && $json.body.data) ? $json.body.data : $json.data }}内容，整理成标准格式。

##注意事项：
1、身高单位换算，均以cm为单位展现；
2、体重单位换算，均以kg为单位展现；
3、三围单位换算，均以cm为单位展现，三个数字用“-”分隔；
4、语言能力，写语种的直接展现所写的语种，写双语没写语种的展现英语，空白的展现单语，不要使用括号；
5、工作经验，按品牌种类、岗位归纳内容，不要使用括号。如果不能区分统一放到最后一行，所有行都标记顺序号。
以上信息如果有修改，直接显示结果，不要显示推理过程。

##标准格式：
姓名：王甜甜
身高：173cm
体重：47kg
三围：83-60-89
服装尺码：M
鞋码：39
语言能力：双语
工作经验：
1、爱马仕、古驰服饰礼仪
2、罗意威匠艺天地展览讲解员
3、爱彼皇家橡树系列讲解员
4、法拉利、上海沃尔沃、捷尼赛思讲解员
5、北京沃尔沃、上海A展领克礼仪`;

const materialWriterCode = `const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const webhook = $('前端录入 Webhook').first().json;
const item = webhook.body || webhook;
const ai = $input.first().json;
const processedText = String(ai.output || ai.text || ai.response || item.data || '').trim();

function clean(value, fallback = 'unknown') {
  const text = String(value || fallback).trim();
  return (text || fallback).replace(/[\\\\/?:*<>|"]/g, '_').replace(/\\s+/g, '_');
}

function cleanPersonName(value) {
  return String(value || '').trim().replace(/[\\\\/?:*<>|"]/g, '_').replace(/\\s+/g, '');
}

function extractPersonName(text) {
  const explicit = String(text || '').match(/姓名[:：\\s]*([^\\n\\r，,；;]+)/);
  const explicitName = cleanPersonName(explicit && explicit[1]);
  if (explicitName) return explicitName;
  const compact = String(text || '').match(/^\\s*([\\u4e00-\\u9fa5·]{2,6})(?=\\s*(?:身高|年龄|体重|三围|服装|衣服|尺码|鞋码|语言|双语|单语|工作经验|参加过))/);
  return cleanPersonName(compact && compact[1]);
}

function beijingTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  const usableDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(usableDate).replace(/\\D/g, '').slice(0, 14);
}

function projectDirName(value) {
  return clean(value, '未命名项目');
}

const roleName = clean(item.roleName, '未命名职别');
const processedPersonName = extractPersonName(processedText);
const incomingPersonName = clean(item.personName, '未识别姓名');
const personName = processedPersonName || incomingPersonName;
const phone = clean(item.phone, '未填手机号');
const uploadTime = clean(beijingTimestamp(item.uploadTime));
const incomingModelName = clean(item.modelName || [incomingPersonName, phone, roleName, uploadTime].join('_'));
const shouldRenameModel = processedPersonName && (!item.personName || item.personName === '未识别姓名' || incomingModelName.startsWith('未识别姓名_'));
const modelName = shouldRenameModel
  ? clean(incomingModelName.startsWith('未识别姓名_')
    ? processedPersonName + incomingModelName.slice('未识别姓名'.length)
    : [processedPersonName, phone, roleName, uploadTime].join('_'))
  : incomingModelName;

const finalDir = path.join('/home/node/.n8n-files/model-card', projectDirName(item.projectName));
const tempDir = path.join('/tmp/model-card', projectDirName(item.projectName), modelName);
fs.mkdirSync(tempDir, { recursive: true });

const results = [];

function push(filePath, fileName) {
  results.push({
    json: {
      Key: filePath,
      dirPath: tempDir + '/',
      finalDir: finalDir + '/',
      fileName,
      filePath,
      modelName,
      projectName: item.projectName,
      roleName: item.roleName,
      personName,
      phone: item.phone,
      uploadTime,
      submissionId: item.submissionId,
    },
  });
}

function writeBase64(fileInfo, suffix, defaultExt) {
  if (!fileInfo || !fileInfo.data) return;
  const ext = path.extname(fileInfo.name || '') || defaultExt;
  const fileName = modelName + '_' + suffix + ext.toLowerCase();
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(fileInfo.data, 'base64'));
  push(filePath, fileName);
}

function writeVideo(fileInfo, suffix) {
  if (!fileInfo || !fileInfo.data) return;
  const ext = (path.extname(fileInfo.name || '') || '.mp4').toLowerCase();
  const rawName = modelName + '_' + suffix + ext;
  const rawPath = path.join(tempDir, rawName);
  fs.writeFileSync(rawPath, Buffer.from(fileInfo.data, 'base64'));

  if (ext === '.mp4') {
    push(rawPath, rawName);
    return;
  }

  const mp4Name = modelName + '_' + suffix + '.mp4';
  const mp4Path = path.join(tempDir, mp4Name);
  const converted = spawnSync('ffmpeg', [
    '-y',
    '-i', rawPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    mp4Path,
  ], { encoding: 'utf8' });

  if (converted.status !== 0 || !fs.existsSync(mp4Path) || fs.statSync(mp4Path).size === 0) {
    throw new Error('视频转 MP4 失败：' + (converted.stderr || converted.stdout || 'ffmpeg 执行失败'));
  }
  push(mp4Path, mp4Name);
}

const txtName = modelName + '.txt';
const txtPath = path.join(tempDir, txtName);
fs.writeFileSync(txtPath, processedText, 'utf8');
push(txtPath, txtName);

writeBase64(item.page1 && item.page1.bestPhoto, 'best_photo', '.jpg');
writeVideo(item.page1 && item.page1.bestVideo, 'best_video');

const photos = (item.otherPages && item.otherPages.photos) || [];
for (let i = 0; i < Math.min(photos.length, 2); i++) {
  writeBase64(photos[i], 'photo_' + (i + 2), '.jpg');
}

const videos = (item.otherPages && item.otherPages.videos) || [];
for (let i = 0; i < Math.min(videos.length, 1); i++) {
  writeVideo(videos[i], 'video_' + (i + 2));
}

return results;`;

const prepareInputCode = `const item = $input.first().json;
return [{
  json: {
    ...item,
    modelName: item.appended_modelName && item.appended_modelName[0] ? item.appended_modelName[0] : 'model_card',
    personName: item.appended_personName && item.appended_personName[0] ? item.appended_personName[0] : '',
  },
}];`;

const diskWriterCode = `const fs = require('fs');
const path = require('path');

const summary = $('汇总素材路径').item.json;
const code = $('Code in Python1').item.json;
const finalDir = summary.appended_finalDir && summary.appended_finalDir[0];
const modelName = $('准备PPTX输入').item.json.modelName;
const personName = $('准备PPTX输入').item.json.personName;
const fileName = modelName + '.pptx';
const base64Field = Object.keys(code).find((key) => key.startsWith('pptx_base64_'));

let diskWriteSuccess = false;
let diskWriteError = null;

try {
  if (!finalDir || !base64Field || !code[base64Field]) {
    throw new Error('缺少 PPTX 写入参数');
  }
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, fileName), Buffer.from(code[base64Field], 'base64'));
  diskWriteSuccess = true;
} catch (error) {
  diskWriteError = error.message || String(error);
}

return [{
  json: {
    disk_write_success: diskWriteSuccess,
    disk_write_error: diskWriteError,
  },
}];`;

const cleanupCode = `const fs = require('fs');
const path = require('path');

const summary = $('汇总素材路径').item.json;
const code = $('Code in Python1').item.json;
const diskWrite = $('写入PPTX磁盘').item.json;
const tempDir = summary.appended_dirPath && summary.appended_dirPath[0];
const finalDir = summary.appended_finalDir && summary.appended_finalDir[0];
const submissionId = summary.appended_submissionId && summary.appended_submissionId[0];
const modelName = $('准备PPTX输入').item.json.modelName;
const personName = $('准备PPTX输入').item.json.personName;
const fileName = modelName + '.pptx';
const base64Field = Object.keys(code).find((key) => key.startsWith('pptx_base64_'));

if (tempDir && (tempDir.startsWith('/home/node/.n8n-files/model-card/') || tempDir.startsWith('/tmp/model-card/'))) {
  const cleanTempDir = tempDir.endsWith('/') ? tempDir.slice(0, -1) : tempDir;
  fs.rmSync(cleanTempDir, { recursive: true, force: true });
  const tempRoot = path.dirname(cleanTempDir);
  if (tempRoot.startsWith('/home/node/.n8n-files/model-card/') || tempRoot.startsWith('/tmp/model-card/')) {
    try {
      const remaining = fs.readdirSync(tempRoot);
      if (!remaining.length) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    } catch {}
  }
}

return [{
  json: {
    success: code.success !== false,
    submission_id: submissionId,
    person_name: personName || null,
    personName: personName || null,
    pptx_file_name: fileName,
    pptx_disk_path: finalDir && fileName ? finalDir + fileName : null,
    pptx_base64_field: base64Field,
    pages: code.pages,
    warning: code.warning || (diskWrite.disk_write_error ? 'PPTX 已生成，但写入项目目录失败：' + diskWrite.disk_write_error : null),
    disk_write_success: diskWrite.disk_write_success === true,
    disk_write_error: diskWrite.disk_write_error || null,
    error: code.error || null,
  },
}];`;

const source = await fetchSourceWorkflow();
const sourceNodes = source.nodes || source.activeVersion?.nodes || [];
const pythonNode = sourceNodes.find((item) => item.name === 'Code in Python1');
const convertNode = sourceNodes.find((item) => item.name === 'Convert to File1');

if (!pythonNode || !convertNode) {
  throw new Error('源工作流中未找到 Code in Python1 或 Convert to File1');
}

const pythonClone = structuredClone(pythonNode);
pythonClone.id = id();
pythonClone.position = [1200, 260];
pythonClone.parameters.pythonCode = pythonClone.parameters.pythonCode.replace(
  '"pptx_data": base64.b64encode(pptx_data).decode("ascii"),',
  '"pptx_base64_" + model_name: base64.b64encode(pptx_data).decode("ascii"),',
);
pythonClone.parameters.pythonCode = pythonClone.parameters.pythonCode.replace(
  '(".jpg", ".jpeg", ".png", ".webp")',
  '(".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp")',
);
pythonClone.parameters.pythonCode = pythonClone.parameters.pythonCode.replace(
  'elif lf.endswith(".mp4"):',
  'elif any(lf.endswith(ext) for ext in (".mp4", ".m4v", ".mov")):',
);

const convertClone = structuredClone(convertNode);
convertClone.id = id();
convertClone.position = [1440, 260];
convertClone.parameters.sourceProperty = "={{ Object.keys($json).find((key) => key.startsWith('pptx_base64_')) }}";
convertClone.parameters.binaryPropertyName = 'model_card_pptx';
convertClone.parameters.options = {
  ...(convertClone.parameters.options || {}),
  fileName: "={{ $('准备PPTX输入').item.json.modelName + '.pptx' }}",
};

const workflow = {
  name: 'model-card',
  nodes: [
    node('前端录入 Webhook', 'n8n-nodes-base.webhook', 1, [0, 260], {
      httpMethod: 'POST',
      path: 'model-card',
      responseMode: 'lastNode',
      options: {},
    }),
    node('AI 预处理文本', '@n8n/n8n-nodes-langchain.agent', 3.1, [280, 260], {
      promptType: 'define',
      text: prompt,
      options: {},
    }),
    node('DeepSeek Chat Model', '@n8n/n8n-nodes-langchain.lmChatDeepSeek', 1, [280, 480], {
      model: 'deepseek-v4-flash',
      options: {},
    }, {
      credentials: {
        deepSeekApi: {
          id: '3Lej4mskqW8cGUXz',
          name: 'DeepSeek account',
        },
      },
    }),
    node('写入临时素材', 'n8n-nodes-base.code', 2, [560, 260], {
      language: 'javaScript',
      jsCode: materialWriterCode,
    }),
    node('汇总素材路径', 'n8n-nodes-base.summarize', 1.1, [920, 260], {
      fieldsToSummarize: {
        values: [
          { aggregation: 'append', field: 'Key' },
          { aggregation: 'append', field: 'dirPath' },
          { aggregation: 'append', field: 'finalDir' },
          { aggregation: 'append', field: 'submissionId' },
          { aggregation: 'append', field: 'modelName' },
          { aggregation: 'append', field: 'personName' },
        ],
      },
      options: {
        outputFormat: 'singleItem',
      },
    }),
    node('准备PPTX输入', 'n8n-nodes-base.code', 2, [1080, 260], {
      language: 'javaScript',
      jsCode: prepareInputCode,
    }),
    pythonClone,
    convertClone,
    node('写入PPTX磁盘', 'n8n-nodes-base.code', 2, [1680, 260], {
      language: 'javaScript',
      jsCode: diskWriterCode,
    }),
    node('清理并响应', 'n8n-nodes-base.code', 2, [1920, 260], {
      language: 'javaScript',
      jsCode: cleanupCode,
    }),
  ],
  connections: {
    '前端录入 Webhook': {
      main: [[{ node: 'AI 预处理文本', type: 'main', index: 0 }]],
    },
    'DeepSeek Chat Model': {
      ai_languageModel: [[{ node: 'AI 预处理文本', type: 'ai_languageModel', index: 0 }]],
    },
    'AI 预处理文本': {
      main: [[{ node: '写入临时素材', type: 'main', index: 0 }]],
    },
    '写入临时素材': {
      main: [[{ node: '汇总素材路径', type: 'main', index: 0 }]],
    },
    '汇总素材路径': {
      main: [[{ node: '准备PPTX输入', type: 'main', index: 0 }]],
    },
    '准备PPTX输入': {
      main: [[{ node: 'Code in Python1', type: 'main', index: 0 }]],
    },
    'Code in Python1': {
      main: [[{ node: 'Convert to File1', type: 'main', index: 0 }]],
    },
    'Convert to File1': {
      main: [[{ node: '写入PPTX磁盘', type: 'main', index: 0 }]],
    },
    '写入PPTX磁盘': {
      main: [[{ node: '清理并响应', type: 'main', index: 0 }]],
    },
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Shanghai',
    callerPolicy: 'workflowsFromSameOwner',
  },
};

fs.mkdirSync(path.resolve('n8n'), { recursive: true });
fs.writeFileSync(path.resolve('n8n/model-card-workflow.json'), JSON.stringify(workflow, null, 2));
console.log('generated n8n/model-card-workflow.json');
