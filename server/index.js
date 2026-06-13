import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import JSZip from 'jszip';
import { pool, initDb, ensureDefaultAdmin, backfillProjectCreators } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const siteUrl = (process.env.SITE_URL || 'https://yh.ccyinghe.com').replace(/\/+$/, '');
const githubApiBaseUrl = (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
const githubApiVersion = process.env.GITHUB_API_VERSION || '2026-03-10';
const githubToken = process.env.GITHUB_TOKEN || '';
const githubOwner = String(process.env.GITHUB_OWNER || '').trim();
const allowedOrigins = [...new Set([
  siteUrl,
  ...(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
])];
const appVersion = 'github-api-admin-20260613';
const mergedPptxJobs = new Map();
const submissionQueue = [];
let activeSubmissionJobs = 0;
const submissionWorkerConcurrency = Math.max(1, Number(process.env.SUBMISSION_WORKER_CONCURRENCY || 2) || 2);
const configuredSessionSecret = process.env.SESSION_SECRET || '';
const weakSessionSecret = !configuredSessionSecret
  || configuredSessionSecret === 'change-this-to-a-long-random-secret'
  || configuredSessionSecret.length < 32;
const sessionSecret = weakSessionSecret ? crypto.randomBytes(48).toString('hex') : configuredSessionSecret;

if (weakSessionSecret) {
  console.warn('SESSION_SECRET is missing or weak; generated a temporary startup secret.');
}

const app = express();
const PgSession = connectPgSimple(session);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 5,
  },
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
  },
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir, { index: false }));
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'model_card_sessions',
    createTableIfMissing: true,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'mc.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
  },
}));
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
});

const submissionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '提交过于频繁，请 10 分钟后再试' },
});

function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();

  const splitHeader = (value) => String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const forwardedPorts = splitHeader(req.get('x-forwarded-port'));
  const hostValues = [req.get('host'), req.get('x-forwarded-host')]
    .filter(Boolean)
    .flatMap(splitHeader)
    .filter(Boolean);

  const hosts = new Set(hostValues);
  for (const host of hostValues) {
    const hasPort = /:\d+$/.test(host);
    const hostName = host.replace(/:\d+$/, '');
    hosts.add(hostName);
    if (!hasPort) forwardedPorts.forEach((port) => hosts.add(`${host}:${port}`));
  }

  let siteHost = '';
  let siteOrigin = siteUrl;
  try {
    const parsedSiteUrl = new URL(siteUrl);
    siteHost = parsedSiteUrl.hostname;
    siteOrigin = parsedSiteUrl.origin;
    hosts.add(parsedSiteUrl.host);
    hosts.add(parsedSiteUrl.hostname);
  } catch {
    // Keep SITE_URL exact matching even if it is misconfigured.
  }

  const sameOriginCandidates = new Set([
    siteOrigin,
    ...allowedOrigins,
    ...[...hosts].flatMap((host) => [`http://${host}`, `https://${host}`]),
  ]);
  if (sameOriginCandidates.has(origin.replace(/\/+$/, ''))) return next();

  try {
    const parsedOrigin = new URL(origin);
    if (hosts.has(parsedOrigin.host) || hosts.has(parsedOrigin.hostname) || parsedOrigin.hostname === siteHost) {
      return next();
    }
  } catch {
    // Invalid Origin headers fall through to the rejection below.
  }

  res.status(403).json({ error: '非法来源请求' });
}

app.use(requireSameOrigin);

async function loadSessionAdmin(req) {
  if (!req.session?.adminId) return null;
  const { rows } = await pool.query(
    'SELECT id, username, display_name, created_at FROM model_card_admins WHERE id = $1',
    [req.session.adminId]
  );
  const admin = rows[0] ? {
    id: rows[0].id,
    loginName: rows[0].username,
    username: rows[0].display_name || rows[0].username,
    isSuperAdmin: rows[0].username === 'admin',
    createdAt: rows[0].created_at,
  } : null;
  req.session.admin = admin;
  return admin;
}

async function requireAdmin(req, res, next) {
  try {
    const admin = await loadSessionAdmin(req);
    if (admin) {
      req.admin = admin;
      return next();
    }
    res.status(401).json({ error: '未登录' });
  } catch (error) {
    next(error);
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.isSuperAdmin) return next();
  res.status(403).json({ error: '只有 admin 用户可以执行此操作' });
}

function cleanName(value) {
  return String(value || '').trim();
}

function validatePassword(password) {
  if (String(password || '').length < 8) {
    throw new Error('密码至少需要 8 位');
  }
}

function canMaintainProject(admin, project) {
  return Boolean(admin?.isSuperAdmin || String(project?.created_by || '') === String(admin?.id));
}

function safeFileName(value) {
  return cleanName(value).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_') || 'model_card';
}

function projectDiskDir(name) {
  return `/home/node/.n8n-files/model-card/${safeFileName(name)}/`;
}

function fileToPayload(file, kind) {
  if (!file) return null;
  const imageInfo = kind === 'image' ? detectImage(file.buffer) : null;
  const originalName = imageInfo ? normalizeFileExtension(file.originalname, imageInfo.extension) : file.originalname;
  return {
    name: originalName,
    mimeType: imageInfo?.mimeType || file.mimetype,
    size: file.size,
    data: file.buffer.toString('base64'),
  };
}

function validateFileSize(file, maxMb, label) {
  if (file && file.size > maxMb * 1024 * 1024) {
    throw new Error(`${label}不能超过 ${maxMb}M`);
  }
}

function startsWithBytes(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function asciiAt(buffer, start, length) {
  if (!buffer || buffer.length < start + length) return '';
  return buffer.subarray(start, start + length).toString('ascii');
}

function detectImage(buffer) {
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (startsWithBytes(buffer, [0x42, 0x4d])) {
    return { mimeType: 'image/bmp', extension: '.bmp' };
  }
  return null;
}

function normalizeFileExtension(fileName, extension) {
  const safeName = fileName || `upload${extension}`;
  const currentExtension = path.extname(safeName).toLowerCase();
  if (currentExtension === extension) return safeName;
  if (extension === '.jpg' && currentExtension === '.jpeg') return safeName;
  if (currentExtension) return safeName.slice(0, -currentExtension.length) + extension;
  return safeName + extension;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function isAllowedVideo(file) {
  const buffer = file?.buffer;
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime === 'video/webm') return startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mime === 'video/mp4' || mime === 'video/quicktime') return asciiAt(buffer, 4, 4) === 'ftyp' || asciiAt(buffer, 4, 4) === 'moov';
  return false;
}

function validateUploadFile(file, label, kind) {
  if (!file) return;
  if (kind === 'image') {
    if (!detectImage(file.buffer)) throw new Error(`${label}文件类型不支持，请上传 .jpg、.jpeg、.bmp、.gif 或 .png 图片`);
    return;
  }
  if (kind !== 'video') return;
  if (!isAllowedVideo(file)) throw new Error(`${label}文件类型不支持，请上传有效的视频文件`);
}

function extractName(introText) {
  const text = String(introText || '');
  const match = text.match(/姓名[:：\s]*([^\n\r，,；;]+)/);
  return cleanName(match?.[1]) || '未识别姓名';
}

function excelFileName(value) {
  return safeFileName(value).replace(/_+/g, '_') || 'model-card-submissions';
}

function absoluteSiteUrl(value) {
  const text = String(value || '');
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${siteUrl}${text}`;
  return text;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value) {
  return String(value ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function xmlAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attrs[match[1]] = xmlUnescape(match[2]);
  }
  return attrs;
}

function relationshipTag(attrs) {
  const ordered = ['Id', 'Type', 'Target', 'TargetMode'];
  const names = [...ordered, ...Object.keys(attrs).filter((name) => !ordered.includes(name))];
  return `<Relationship ${names
    .filter((name) => attrs[name] != null)
    .map((name) => `${name}="${xmlEscape(attrs[name])}"`)
    .join(' ')}/>`;
}

function parseRelationships(xml) {
  return [...String(xml || '').matchAll(/<Relationship\b[^>]*\/>/g)].map((match) => xmlAttributes(match[0]));
}

function relationshipXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships.map(relationshipTag).join('\n  ')}
</Relationships>`;
}

function resolvePartTarget(ownerPartPath, target) {
  const text = String(target || '');
  if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  const normalized = text.startsWith('/')
    ? path.posix.normalize(text.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPartPath), text));
  return normalized.replace(/^\.\//, '');
}

function relativePartTarget(ownerPartPath, targetPartPath) {
  let relative = path.posix.relative(path.posix.dirname(ownerPartPath), targetPartPath);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative.replace(/^\.\//, '');
}

function relsPathForPart(partPath) {
  const dir = path.posix.dirname(partPath);
  const base = path.posix.basename(partPath);
  return `${dir}/_rels/${base}.rels`;
}

function contentTypesInfo(xml) {
  const defaults = new Map();
  const overrides = new Map();
  for (const attrs of [...String(xml || '').matchAll(/<Default\b[^>]*\/>/g)].map((match) => xmlAttributes(match[0]))) {
    if (attrs.Extension && attrs.ContentType) defaults.set(attrs.Extension.toLowerCase(), attrs.ContentType);
  }
  for (const attrs of [...String(xml || '').matchAll(/<Override\b[^>]*\/>/g)].map((match) => xmlAttributes(match[0]))) {
    if (attrs.PartName && attrs.ContentType) overrides.set(attrs.PartName, attrs.ContentType);
  }
  return { defaults, overrides };
}

function contentTypeForPart(info, partPath) {
  const partName = `/${partPath}`;
  const ext = path.posix.extname(partPath).slice(1).toLowerCase();
  return info.overrides.get(partName) || info.defaults.get(ext) || null;
}

function guessedContentType(partPath) {
  const ext = path.posix.extname(partPath).slice(1).toLowerCase();
  const known = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    xml: 'application/xml',
    rels: 'application/vnd.openxmlformats-package.relationships+xml',
  };
  return known[ext] || 'application/octet-stream';
}

function ensureDefaultContentType(xml, extension, contentType) {
  if (!extension || !contentType || new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"`, 'i').test(xml)) return xml;
  return xml.replace('</Types>', `  <Default Extension="${xmlEscape(extension)}" ContentType="${xmlEscape(contentType)}"/>\n</Types>`);
}

function ensureOverrideContentType(xml, partName, contentType) {
  if (!partName || !contentType || new RegExp(`<Override\\b[^>]*\\bPartName="${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(xml)) return xml;
  return xml.replace('</Types>', `  <Override PartName="${xmlEscape(partName)}" ContentType="${xmlEscape(contentType)}"/>\n</Types>`);
}

async function sourceSlidePaths(zip) {
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentationXml || !relsXml) throw new Error('PPTX 文件缺少 presentation.xml 或关系文件');

  const relsById = new Map(parseRelationships(relsXml).map((rel) => [rel.Id, rel]));
  const slidePaths = [];
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
    const rel = relsById.get(xmlUnescape(match[1]));
    if (rel?.Target && /\/slide$/i.test(rel.Type || '')) {
      slidePaths.push(resolvePartTarget('ppt/presentation.xml', rel.Target));
    }
  }
  if (!slidePaths.length) throw new Error('PPTX 文件中没有可合并的幻灯片');
  return slidePaths;
}

function nextUniquePartPath(zip, sourcePartPath, prefix) {
  const ext = path.posix.extname(sourcePartPath);
  const dir = path.posix.dirname(sourcePartPath);
  const rawBase = path.posix.basename(sourcePartPath, ext).replace(/[^\w.-]+/g, '_') || 'part';
  let candidate = `${dir}/${prefix}-${rawBase}${ext}`;
  let counter = 1;
  while (zip.file(candidate)) {
    candidate = `${dir}/${prefix}-${rawBase}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

function shouldCopySlideTarget(partPath) {
  return /^ppt\/(media|embeddings)\//.test(partPath);
}

function nextRelationshipId(relationships, usedIds = new Set()) {
  const existing = new Set([
    ...relationships.map((rel) => rel.Id).filter(Boolean),
    ...usedIds,
  ]);
  let index = 1;
  while (existing.has(`rId${index}`)) index += 1;
  const id = `rId${index}`;
  usedIds.add(id);
  return id;
}

async function rewriteSlideRelationships({
  sourceZip,
  outputZip,
  sourceContentTypes,
  destContentTypes,
  sourceSlidePath,
  destSlidePath,
  prefix,
}) {
  const relsPath = relsPathForPart(sourceSlidePath);
  const relsFile = sourceZip.file(relsPath);
  if (!relsFile) return destContentTypes;

  const copiedParts = new Map();
  const relsXml = await relsFile.async('string');
  const rewritten = await asyncReplace(relsXml, /<Relationship\b[^>]*\/>/g, async (tag) => {
    const attrs = xmlAttributes(tag);
    if (!attrs.Target || attrs.TargetMode === 'External') return tag;

    const sourcePartPath = resolvePartTarget(sourceSlidePath, attrs.Target);
    if (!shouldCopySlideTarget(sourcePartPath)) return tag;

    let destPartPath = copiedParts.get(sourcePartPath);
    if (!destPartPath) {
      const sourceFile = sourceZip.file(sourcePartPath);
      if (!sourceFile) return tag;

      destPartPath = nextUniquePartPath(outputZip, sourcePartPath, prefix);
      copiedParts.set(sourcePartPath, destPartPath);
      outputZip.file(destPartPath, await sourceFile.async('nodebuffer'));

      const ext = path.posix.extname(destPartPath).slice(1).toLowerCase();
      const sourceType = contentTypeForPart(sourceContentTypes, sourcePartPath) || guessedContentType(sourcePartPath);
      destContentTypes = ensureDefaultContentType(destContentTypes, ext, sourceType);
    }

    attrs.Target = relativePartTarget(destSlidePath, destPartPath);
    return relationshipTag(attrs);
  });

  outputZip.file(relsPathForPart(destSlidePath), rewritten);
  return destContentTypes;
}

async function asyncReplace(value, regex, replacer) {
  const parts = [];
  let lastIndex = 0;
  for (const match of String(value).matchAll(regex)) {
    parts.push(value.slice(lastIndex, match.index));
    parts.push(await replacer(match[0], match));
    lastIndex = match.index + match[0].length;
  }
  parts.push(value.slice(lastIndex));
  return parts.join('');
}

async function mergePptxBuffers(buffers) {
  if (!buffers.length) throw new Error('没有可合并的 PPTX 文件');

  const sourceZips = await Promise.all(buffers.map((buffer) => JSZip.loadAsync(buffer)));
  const outputZip = await JSZip.loadAsync(buffers[0]);
  let destContentTypes = await outputZip.file('[Content_Types].xml')?.async('string');
  if (!destContentTypes) throw new Error('PPTX 文件缺少 [Content_Types].xml');

  for (const name of Object.keys(outputZip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)) {
      outputZip.remove(name);
    }
  }

  let presentationXml = await outputZip.file('ppt/presentation.xml')?.async('string');
  const presentationRelsXml = await outputZip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentationXml || !presentationRelsXml) throw new Error('PPTX 文件缺少 presentation.xml 或关系文件');

  const presentationRels = parseRelationships(presentationRelsXml)
    .filter((rel) => !/\/slide$/i.test(rel.Type || ''));
  const newSlideIds = [];
  const usedPresentationRelIds = new Set();
  let destSlideIndex = 1;

  for (let sourceIndex = 0; sourceIndex < sourceZips.length; sourceIndex += 1) {
    const sourceZip = sourceZips[sourceIndex];
    const sourceContentTypes = contentTypesInfo(await sourceZip.file('[Content_Types].xml')?.async('string'));
    const slidePaths = await sourceSlidePaths(sourceZip);

    for (let slideIndex = 0; slideIndex < slidePaths.length; slideIndex += 1) {
      const sourceSlidePath = slidePaths[slideIndex];
      const sourceSlide = sourceZip.file(sourceSlidePath);
      if (!sourceSlide) continue;

      const destSlidePath = `ppt/slides/slide${destSlideIndex}.xml`;
      const relId = nextRelationshipId(presentationRels, usedPresentationRelIds);
      const prefix = `source${sourceIndex + 1}-slide${slideIndex + 1}-dest${destSlideIndex}`;

      outputZip.file(destSlidePath, await sourceSlide.async('nodebuffer'));
      destContentTypes = ensureOverrideContentType(
        destContentTypes,
        `/${destSlidePath}`,
        contentTypeForPart(sourceContentTypes, sourceSlidePath)
          || 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
      );
      destContentTypes = await rewriteSlideRelationships({
        sourceZip,
        outputZip,
        sourceContentTypes,
        destContentTypes,
        sourceSlidePath,
        destSlidePath,
        prefix,
      });

      presentationRels.push({
        Id: relId,
        Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
        Target: `slides/slide${destSlideIndex}.xml`,
      });
      newSlideIds.push(`<p:sldId id="${255 + destSlideIndex}" r:id="${relId}"/>`);
      destSlideIndex += 1;
    }
  }

  if (!newSlideIds.length) throw new Error('没有可合并的 PPTX 幻灯片');

  if (/<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/.test(presentationXml)) {
    presentationXml = presentationXml.replace(
      /<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/,
      `<p:sldIdLst>${newSlideIds.join('')}</p:sldIdLst>`,
    );
  } else {
    presentationXml = presentationXml.replace(
      /<\/p:presentation>/,
      `<p:sldIdLst>${newSlideIds.join('')}</p:sldIdLst></p:presentation>`,
    );
  }

  outputZip.file('ppt/presentation.xml', presentationXml);
  outputZip.file('ppt/_rels/presentation.xml.rels', relationshipXml(presentationRels));
  outputZip.file('[Content_Types].xml', destContentTypes);

  return outputZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function excelCellRef(rowIndex, columnIndex) {
  let column = '';
  let index = columnIndex;
  while (index > 0) {
    const mod = (index - 1) % 26;
    column = String.fromCharCode(65 + mod) + column;
    index = Math.floor((index - mod) / 26);
  }
  return `${column}${rowIndex}`;
}

async function rowsToExcelWorkbook(rows) {
  const headers = rows[0]
    ? Object.keys(rows[0])
    : ['项目名称', '姓名', '职别', '联系电话', '微信号', 'PPTX 文件 Url 下载位置', '上传时间'];
  const urlColumnIndex = headers.indexOf('PPTX 文件 Url 下载位置');
  const allRows = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))];
  const relationships = [];
  const hyperlinkXml = [];

  const rowXml = allRows.map((cells, rowIndex) => {
    const excelRow = rowIndex + 1;
    const cellXml = cells.map((value, columnIndex) => {
      const excelColumn = columnIndex + 1;
      const cellRef = excelCellRef(excelRow, excelColumn);
      const text = String(value ?? '');
      const style = rowIndex === 0 ? ' s="1"' : '';
      if (rowIndex > 0 && columnIndex === urlColumnIndex && /^https?:\/\//i.test(text)) {
        const relId = `rId${relationships.length + 1}`;
        relationships.push({ id: relId, target: text });
        hyperlinkXml.push(`<hyperlink ref="${cellRef}" r:id="${relId}"/>`);
        return `<c r="${cellRef}" t="inlineStr" s="2"><is><t>${xmlEscape(text)}</t></is></c>`;
      }
      return `<c r="${cellRef}" t="inlineStr"${style}><is><t>${xmlEscape(text)}</t></is></c>`;
    }).join('');
    return `<row r="${excelRow}">${cellXml}</row>`;
  }).join('');

  const colsXml = headers.map((header, index) => {
    const width = header === 'PPTX 文件 Url 下载位置'
      ? 56
      : Math.max(12, Math.min(24, String(header).length + 8));
    const column = index + 1;
    return `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`;
  }).join('');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Model Card Portal</dc:creator>
  <cp:lastModifiedBy>Model Card Portal</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Model Card Portal</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="报名清单" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3"><font/><font><b/></font><font><u/><color rgb="FF0563C1"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>${colsXml}</cols>
  <sheetData>${rowXml}</sheetData>
  ${hyperlinkXml.length ? `<hyperlinks>${hyperlinkXml.join('')}</hyperlinks>` : ''}
</worksheet>`);
  if (relationships.length) {
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships.map((rel) => `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(rel.target)}" TargetMode="External"/>`).join('')}
</Relationships>`);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function submissionFilters(query) {
  const params = [];
  const where = [];
  const roleIds = []
    .concat(query.roleId || [])
    .flatMap((value) => String(value).split(','))
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (query.projectId) {
    params.push(query.projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (roleIds.length) {
    params.push(roleIds);
    where.push(`role_id = ANY($${params.length}::int[])`);
  }
  return { params, where };
}

function dedupedSubmissionsSql(selectColumns, where, orderBy = 'submitted_at DESC', outerWhere = []) {
  const dedupedWhere = ['duplicate_rank = 1', ...outerWhere];
  return `SELECT ${selectColumns}
    FROM (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY person_name, phone, role_name
               ORDER BY submitted_at DESC, id DESC
             ) AS duplicate_rank
      FROM model_card_submissions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ) deduped_submissions
    WHERE ${dedupedWhere.join(' AND ')}
    ORDER BY ${orderBy}`;
}

async function mergePptxRows(rows) {
  const token = crypto.randomBytes(16).toString('hex');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-card-merge-'));
  const outputDir = path.join(workDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const outputFileName = `${token}.pptx`;
  const filePath = path.join(outputDir, outputFileName);
  const outputBuffer = await mergePptxBuffers(rows.map((row) => Buffer.from(row.pptx_base64, 'base64')));
  fs.writeFileSync(filePath, outputBuffer);
  const projectNames = [...new Set(rows.map((row) => row.project_name).filter(Boolean))];
  const baseName = projectNames.length === 1 ? `${projectNames[0]}-合并模卡` : '全部项目-合并模卡';
  const fileName = `${excelFileName(baseName)}.pptx`;
  mergedPptxJobs.set(token, {
    filePath,
    fileName,
    workDir,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  return { token, fileName, count: rows.length };
}

function cleanupMergedPptxJobs() {
  const now = Date.now();
  for (const [token, job] of mergedPptxJobs.entries()) {
    if (job.expiresAt > now) continue;
    fs.rmSync(job.workDir, { recursive: true, force: true });
    mergedPptxJobs.delete(token);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(extractWorkflowError(data) || `HTTP ${response.status}`);
  }
  return data;
}

function extractWorkflowError(value) {
  if (!value || typeof value !== 'object') return '';
  const message = value.error?.message
    || value.error
    || value.message
    || value.data?.resultData?.error?.message
    || value.resultData?.error?.message
    || '';
  return typeof message === 'string' ? message : '';
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': githubApiVersion,
    'User-Agent': 'model-card-portal',
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  return headers;
}

function extractGithubError(value) {
  if (!value || typeof value !== 'object') return '';
  const message = typeof value.message === 'string' ? value.message : '';
  const errors = Array.isArray(value.errors)
    ? value.errors
      .map((item) => item?.message || item?.code || '')
      .filter(Boolean)
      .join('；')
    : '';
  return [message, errors].filter(Boolean).join('：');
}

async function githubJson(pathname, query = {}) {
  const url = new URL(`${githubApiBaseUrl}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(url, { headers: githubHeaders() });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(extractGithubError(data) || `GitHub API HTTP ${response.status}`);
  }
  return data;
}

function requireGithubToken(_req, res, next) {
  if (githubToken) return next();
  res.status(503).json({ error: '未配置 GITHUB_TOKEN，无法连接 GitHub API' });
}

function githubPageQuery(query) {
  const page = Math.max(1, Number(query.page || 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.perPage || query.per_page || 30) || 30));
  return { page, per_page: perPage };
}

function queueSubmissionJob(submissionId) {
  submissionQueue.push(submissionId);
  processSubmissionQueue();
}

async function restoreQueuedSubmissionJobs() {
  await pool.query(
    `UPDATE model_card_submissions
     SET status = 'queued', updated_at = NOW()
     WHERE status = 'processing'
       AND n8n_response ? 'queuedPayload'`
  );
  const { rows } = await pool.query(
    `SELECT id
     FROM model_card_submissions
     WHERE status = 'queued'
     ORDER BY submitted_at ASC, id ASC`
  );
  rows.forEach((row) => queueSubmissionJob(row.id));
}

function processSubmissionQueue() {
  while (activeSubmissionJobs < submissionWorkerConcurrency && submissionQueue.length) {
    const submissionId = submissionQueue.shift();
    activeSubmissionJobs += 1;
    processSubmissionJob(submissionId)
      .catch((error) => {
        console.error(`Submission job ${submissionId} failed`, error);
      })
      .finally(() => {
        activeSubmissionJobs -= 1;
        processSubmissionQueue();
      });
  }
}

async function processSubmissionJob(submissionId) {
  const claimed = await pool.query(
    `UPDATE model_card_submissions
     SET status = 'processing', updated_at = NOW()
     WHERE id = $1 AND status = 'queued'
     RETURNING n8n_response, download_token`,
    [submissionId]
  );
  const row = claimed.rows[0];
  if (!row) return;

  const payload = row.n8n_response?.queuedPayload;
  if (!payload) {
    await pool.query(
      `UPDATE model_card_submissions
       SET status = 'failed',
           n8n_response = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [submissionId, { success: false, error: '队列任务缺少生成参数' }]
    );
    return;
  }

  try {
    const n8nRawResult = await fetchJson(process.env.N8N_WEBHOOK_URL || 'https://n8n.ccyinghe.com/webhook/model-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const n8nResult = Array.isArray(n8nRawResult) ? (n8nRawResult[0] || {}) : n8nRawResult;
    const workflowError = extractWorkflowError(n8nResult);
    const doneStatus = n8nResult.success === false ? 'failed' : 'done';

    await pool.query(
      `UPDATE model_card_submissions
       SET status = $2,
           pptx_file_name = $3,
           pptx_disk_path = $4,
           pptx_base64 = $5,
           pptx_url = $6,
           n8n_response = $7,
           updated_at = NOW()
       WHERE id = $1`,
      [
        submissionId,
        doneStatus,
        doneStatus === 'done' ? n8nResult.pptx_file_name || n8nResult.file_name || `${payload.modelName}.pptx` : null,
        doneStatus === 'done' ? n8nResult.pptx_disk_path || null : null,
        doneStatus === 'done' ? n8nResult.pptx_base64 || null : null,
        doneStatus === 'done' ? `${siteUrl}/api/submissions/download/${row.download_token}` : null,
        workflowError ? { ...n8nResult, error: workflowError } : n8nResult,
      ]
    );
  } catch (error) {
    await pool.query(
      `UPDATE model_card_submissions
       SET status = 'failed',
           n8n_response = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [submissionId, { success: false, error: error.message || 'n8n 生成失败' }]
    );
  }
}

async function syncProjectDir(payload, options = {}) {
  const url = process.env.N8N_PROJECT_DIR_WEBHOOK_URL || 'https://n8n.ccyinghe.com/webhook/model-card-project-dir';
  try {
    const result = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const firstResult = Array.isArray(result) ? (result[0] || {}) : result;
    const normalizedResult = firstResult?.json && typeof firstResult.json === 'object'
      ? firstResult.json
      : firstResult;
    if (normalizedResult?.success === false) {
      throw new Error(normalizedResult.error || 'n8n 项目目录同步失败');
    }
    return normalizedResult;
  } catch (error) {
    if (options.required) throw error;
    return null;
  }
}

async function deleteProjectRecord(client, project) {
  await client.query(
    'DELETE FROM model_card_submissions WHERE project_id = $1 OR project_name = $2',
    [project.id, project.name]
  );
  await client.query('DELETE FROM model_card_roles WHERE project_id = $1', [project.id]);
  await client.query('DELETE FROM model_card_projects WHERE id = $1', [project.id]);
  return {
    projectId: project.id,
    projectName: project.name,
  };
}

async function syncDeletedProjectDir(project) {
  const dirResult = await syncProjectDir({ action: 'rm', projectName: project.projectName });
  return {
    ...project,
    dirSynced: Boolean(dirResult),
  };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: appVersion });
});

app.get('/api/public/options', async (_req, res, next) => {
  try {
    const { rows: projects } = await pool.query(
      `SELECT id, name, intro, start_date, end_date
       FROM model_card_projects
       ORDER BY created_at DESC, name ASC`
    );
    const { rows: roles } = await pool.query(
      `SELECT id, project_id, name
       FROM model_card_roles
       ORDER BY name ASC`
    );
    res.json({ projects, roles });
  } catch (error) {
    next(error);
  }
});

app.post('/api/submissions', submissionLimiter, upload.fields([
  { name: 'bestPhoto', maxCount: 1 },
  { name: 'bestVideo', maxCount: 1 },
  { name: 'otherPhotos', maxCount: 2 },
  { name: 'otherVideos', maxCount: 1 },
]), async (req, res, next) => {
  try {
    const projectId = cleanName(req.body.projectId);
    const roleId = cleanName(req.body.roleId);
    const introText = cleanName(req.body.introText);
    const phone = normalizePhone(req.body.phone);
    const wechat = cleanName(req.body.wechat);

    if (!projectId || !roleId || !introText || !phone) {
      throw new Error('报名项目、报名职别、自我介绍文本和联系电话必填');
    }
    if (phone.length !== 11) {
      throw new Error('联系电话请输入 11 位数字');
    }

    const bestPhoto = req.files?.bestPhoto?.[0];
    const bestVideo = req.files?.bestVideo?.[0];
    const otherPhotos = req.files?.otherPhotos || [];
    const otherVideos = req.files?.otherVideos || [];

    if (!bestPhoto) throw new Error('最佳照片必填');
    if (!bestVideo) throw new Error('最佳视频必填');
    validateFileSize(bestPhoto, 6, '最佳照片');
    validateFileSize(bestVideo, 30, '最佳视频');
    otherPhotos.forEach((file, index) => validateFileSize(file, 6, `剩余照片${index + 1}`));
    otherVideos.forEach((file, index) => validateFileSize(file, 30, `剩余视频${index + 1}`));
    validateUploadFile(bestPhoto, '最佳照片', 'image');
    otherPhotos.forEach((file, index) => validateUploadFile(file, `剩余照片${index + 1}`, 'image'));
    validateUploadFile(bestVideo, '最佳视频', 'video');
    otherVideos.forEach((file, index) => validateUploadFile(file, `剩余视频${index + 1}`, 'video'));

    const { rows } = await pool.query(
      `SELECT p.name AS project_name, p.intro AS project_intro, p.start_date, p.end_date, r.name AS role_name
       FROM model_card_projects p
       JOIN model_card_roles r ON r.project_id = p.id
       WHERE p.id = $1 AND r.id = $2`,
      [projectId, roleId]
    );
    if (!rows[0]) throw new Error('项目或职别无效');

    const personName = extractName(introText);
    const submittedAt = new Date();
    const stamp = submittedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const modelName = safeFileName(`${personName}_${phone}_${rows[0].role_name}_${stamp}`);
    const downloadToken = crypto.randomBytes(24).toString('hex');

    const payload = {
      submissionId: null,
      projectName: rows[0].project_name,
      roleName: rows[0].role_name,
      personName,
      phone,
      wechat,
      uploadTime: submittedAt.toISOString(),
      modelName,
      data: introText,
      page1: {
        text: introText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        bestPhoto: fileToPayload(bestPhoto, 'image'),
        bestVideo: fileToPayload(bestVideo),
      },
      otherPages: {
        photos: otherPhotos.map((file) => fileToPayload(file, 'image')),
        videos: otherVideos.map(fileToPayload),
      },
    };

    const insert = await pool.query(
      `INSERT INTO model_card_submissions
       (project_id, role_id, project_name, role_name, person_name, phone, wechat, intro_text, submitted_at, status, download_token, n8n_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11)
       RETURNING id`,
      [
        projectId,
        roleId,
        rows[0].project_name,
        rows[0].role_name,
        personName,
        phone,
        wechat,
        introText,
        submittedAt,
        downloadToken,
        { queuedPayload: payload },
      ]
    );
    const submissionId = insert.rows[0].id;
    payload.submissionId = submissionId;
    await pool.query(
      `UPDATE model_card_submissions
       SET n8n_response = $2, updated_at = NOW()
       WHERE id = $1`,
      [submissionId, { queuedPayload: payload }]
    );

    queueSubmissionJob(submissionId);

    res.status(202).json({
      submissionId,
      status: 'queued',
      statusUrl: `/api/submissions/${submissionId}/status?token=${downloadToken}`,
      projectName: rows[0].project_name,
      projectStartDate: rows[0].start_date,
      projectEndDate: rows[0].end_date,
      personName,
      roleName: rows[0].role_name,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/submissions/:id/status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, project_name, start_date, end_date, person_name, role_name, status,
              pptx_file_name, pptx_url, download_token, n8n_response
       FROM (
         SELECT s.id, s.project_name, p.start_date, p.end_date, s.person_name, s.role_name,
                s.status, s.pptx_file_name, s.pptx_url, s.download_token, s.n8n_response
         FROM model_card_submissions s
         LEFT JOIN model_card_projects p ON p.id = s.project_id
         WHERE s.id = $1 AND s.download_token = $2
       ) submission_status`,
      [req.params.id, cleanName(req.query.token)]
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: '报名记录不存在或校验失败' });
      return;
    }
    const error = row.status === 'failed'
      ? row.n8n_response?.error || row.n8n_response?.message || 'n8n 生成失败'
      : '';
    res.json({
      submissionId: row.id,
      status: row.status,
      fileName: row.pptx_file_name,
      downloadUrl: row.status === 'done' ? absoluteSiteUrl(row.pptx_url) : '',
      error,
      projectName: row.project_name,
      projectStartDate: row.start_date,
      projectEndDate: row.end_date,
      personName: row.person_name,
      roleName: row.role_name,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/submissions/download/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pptx_base64, pptx_file_name FROM model_card_submissions WHERE download_token = $1`,
      [req.params.token]
    );
    const row = rows[0];
    if (!row?.pptx_base64) {
      res.status(404).json({ error: 'PPTX 文件尚未生成或未保存下载数据' });
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(row.pptx_file_name || 'model_card.pptx'))}`);
    res.send(Buffer.from(row.pptx_base64, 'base64'));
  } catch (error) {
    next(error);
  }
});

app.get('/api/submissions/:id/download', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pptx_base64, pptx_file_name FROM model_card_submissions WHERE id = $1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row?.pptx_base64) {
      res.status(404).json({ error: 'PPTX 文件尚未生成或未保存下载数据' });
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(row.pptx_file_name || 'model_card.pptx'))}`);
    res.send(Buffer.from(row.pptx_base64, 'base64'));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
  try {
    const loginName = cleanName(req.body.loginName || req.body.username);
    const password = String(req.body.password || '');
    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_hash, created_at FROM model_card_admins WHERE username = $1',
      [loginName]
    );
    if (!rows[0] || !bcrypt.compareSync(password, rows[0].password_hash)) {
      res.status(401).json({ error: '登录名或密码错误' });
      return;
    }
    req.session.adminId = rows[0].id;
    req.session.admin = {
      id: rows[0].id,
      loginName: rows[0].username,
      username: rows[0].display_name || rows[0].username,
      isSuperAdmin: rows[0].username === 'admin',
      createdAt: rows[0].created_at,
    };
    res.json({ ok: true, admin: req.session.admin });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', async (req, res, next) => {
  try {
    const admin = await loadSessionAdmin(req);
    res.json({ loggedIn: Boolean(admin), admin });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/status', requireAdmin, async (_req, res, next) => {
  try {
    if (!githubToken) {
      res.json({
        configured: false,
        apiBaseUrl: githubApiBaseUrl,
        owner: githubOwner,
        message: '未配置 GITHUB_TOKEN',
      });
      return;
    }
    const user = await githubJson('/user');
    res.json({
      configured: true,
      apiBaseUrl: githubApiBaseUrl,
      owner: githubOwner,
      user: {
        login: user.login,
        name: user.name,
        type: user.type,
        avatarUrl: user.avatar_url,
        htmlUrl: user.html_url,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/user', requireAdmin, requireGithubToken, async (_req, res, next) => {
  try {
    const user = await githubJson('/user');
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/repos', requireAdmin, requireGithubToken, async (req, res, next) => {
  try {
    const owner = cleanName(req.query.owner || githubOwner);
    const ownerType = cleanName(req.query.ownerType || req.query.type || 'auto').toLowerCase();
    const pageQuery = githubPageQuery(req.query);
    let repos;

    if (!owner || ownerType === 'viewer') {
      repos = await githubJson('/user/repos', {
        ...pageQuery,
        visibility: cleanName(req.query.visibility || 'all'),
        affiliation: cleanName(req.query.affiliation || 'owner,collaborator,organization_member'),
        sort: cleanName(req.query.sort || 'updated'),
        direction: cleanName(req.query.direction || 'desc'),
      });
    } else {
      let resolvedOwnerType = ownerType;
      if (resolvedOwnerType === 'auto') {
        const ownerInfo = await githubJson(`/users/${encodeURIComponent(owner)}`);
        if (ownerInfo.type !== 'Organization') {
          const viewer = await githubJson('/user');
          resolvedOwnerType = viewer.login === ownerInfo.login ? 'viewer' : 'user';
        } else {
          resolvedOwnerType = 'org';
        }
      }
      if (resolvedOwnerType === 'viewer') {
        repos = await githubJson('/user/repos', {
          ...pageQuery,
          visibility: cleanName(req.query.visibility || 'all'),
          affiliation: cleanName(req.query.affiliation || 'owner,collaborator,organization_member'),
          sort: cleanName(req.query.sort || 'updated'),
          direction: cleanName(req.query.direction || 'desc'),
        });
      } else {
        const endpoint = resolvedOwnerType === 'org' || resolvedOwnerType === 'organization'
          ? `/orgs/${encodeURIComponent(owner)}/repos`
          : `/users/${encodeURIComponent(owner)}/repos`;
        repos = await githubJson(endpoint, {
          ...pageQuery,
          type: cleanName(req.query.repoType || 'all'),
          sort: cleanName(req.query.sort || 'updated'),
          direction: cleanName(req.query.direction || 'desc'),
        });
      }
    }

    res.json({
      repos: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        description: repo.description,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        language: repo.language,
        stargazersCount: repo.stargazers_count,
        forksCount: repo.forks_count,
        openIssuesCount: repo.open_issues_count,
        pushedAt: repo.pushed_at,
        updatedAt: repo.updated_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/repos/:owner/:repo', requireAdmin, requireGithubToken, async (req, res, next) => {
  try {
    const repo = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}`);
    res.json({ repo });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/repos/:owner/:repo/languages', requireAdmin, requireGithubToken, async (req, res, next) => {
  try {
    const languages = await githubJson(`/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/languages`);
    res.json({ languages });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/github/repos/:owner/:repo/commits', requireAdmin, requireGithubToken, async (req, res, next) => {
  try {
    const commits = await githubJson(
      `/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/commits`,
      {
        ...githubPageQuery(req.query),
        sha: cleanName(req.query.sha),
      }
    );
    res.json({
      commits: commits.map((item) => ({
        sha: item.sha,
        htmlUrl: item.html_url,
        message: item.commit?.message || '',
        authorName: item.commit?.author?.name || item.author?.login || '',
        authorLogin: item.author?.login || '',
        date: item.commit?.author?.date || item.commit?.committer?.date || '',
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', requireAdmin, requireSuperAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username AS login_name, display_name, created_at
       FROM model_card_admins
       ORDER BY username ASC`
    );
    res.json({
      users: rows.map((row) => ({
        id: row.id,
        loginName: row.login_name,
        username: row.display_name || row.login_name,
        created_at: row.created_at,
        isSuperAdmin: row.login_name === 'admin',
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users', requireAdmin, requireSuperAdmin, async (req, res, next) => {
  try {
    const loginName = cleanName(req.body.loginName);
    const username = cleanName(req.body.username);
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(loginName)) {
      throw new Error('登录名只能使用 2-40 位字母、数字、下划线、点或横线');
    }
    if (!username) throw new Error('用户名必填');
    validatePassword(password);
    const existing = await pool.query('SELECT 1 FROM model_card_admins WHERE username = $1', [loginName]);
    if (existing.rows[0]) throw new Error('登录名已存在，请换一个登录名');
    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO model_card_admins (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username AS login_name, display_name, created_at`,
      [loginName, username, hash]
    );
    res.json({
      user: {
        id: rows[0].id,
        loginName: rows[0].login_name,
        username: rows[0].display_name || rows[0].login_name,
        created_at: rows[0].created_at,
        isSuperAdmin: rows[0].login_name === 'admin',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/users/:id/password', requireAdmin, async (req, res, next) => {
  try {
    const targetId = String(req.params.id);
    if (!req.admin.isSuperAdmin && targetId !== String(req.admin.id)) {
      res.status(403).json({ error: '只能修改自己的密码' });
      return;
    }
    const password = String(req.body.password || '');
    validatePassword(password);
    const { rows } = await pool.query('SELECT id, username FROM model_card_admins WHERE id = $1', [targetId]);
    if (!rows[0]) throw new Error('用户不存在');
    const hash = bcrypt.hashSync(password, 10);
    await pool.query('UPDATE model_card_admins SET password_hash = $2 WHERE id = $1', [targetId, hash]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/users/:id/display-name', requireAdmin, requireSuperAdmin, async (req, res, next) => {
  try {
    const username = cleanName(req.body.username);
    if (!username) throw new Error('用户名必填');
    const { rows } = await pool.query(
      `UPDATE model_card_admins
       SET display_name = $2
       WHERE id = $1 AND username <> 'admin'
       RETURNING id, username AS login_name, display_name, created_at`,
      [req.params.id, username]
    );
    if (!rows[0]) throw new Error('用户不存在或不能修改 admin 用户名');
    res.json({
      user: {
        id: rows[0].id,
        loginName: rows[0].login_name,
        username: rows[0].display_name || rows[0].login_name,
        created_at: rows[0].created_at,
        isSuperAdmin: rows[0].login_name === 'admin',
      },
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/users/:id', requireAdmin, requireSuperAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username FROM model_card_admins WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new Error('用户不存在');
    if (rows[0].username === 'admin') throw new Error('不能删除 admin 用户');
    await pool.query('DELETE FROM model_card_admins WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/projects', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
        COALESCE(NULLIF(a.display_name, ''), a.username) AS created_by_username,
        COALESCE(json_agg(r ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM model_card_projects p
       LEFT JOIN model_card_admins a ON a.id = p.created_by
       LEFT JOIN model_card_roles r ON r.project_id = p.id
       GROUP BY p.id, a.display_name, a.username
       ORDER BY p.created_at DESC`
    );
    rows.forEach((row) => {
      row.canEdit = canMaintainProject(req.admin, row);
      row.canDelete = row.canEdit;
    });
    res.json({ projects: rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/project-options', requireAdmin, async (req, res, next) => {
  try {
    const params = [];
    const ownerClause = req.admin.isSuperAdmin ? '' : 'WHERE created_by = $1';
    if (!req.admin.isSuperAdmin) params.push(req.admin.id);
    const { rows } = await pool.query(
      `SELECT id, name
       FROM model_card_projects
       ${ownerClause}
       ORDER BY created_at DESC, name ASC`
      , params
    );
    res.json({ projects: rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/project-role-summary', requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH latest_submissions AS (
         SELECT project_id, role_id
         FROM (
           SELECT project_id,
                  role_id,
                  person_name,
                  phone,
                  ROW_NUMBER() OVER (
                    PARTITION BY project_id, role_id, person_name, phone
                    ORDER BY submitted_at DESC, id DESC
                  ) AS duplicate_rank
           FROM model_card_submissions
         ) ranked_submissions
         WHERE duplicate_rank = 1
       ),
       role_submission_counts AS (
         SELECT project_id, role_id, COUNT(*)::int AS submission_count
         FROM latest_submissions
         GROUP BY project_id, role_id
       )
       SELECT p.id,
              p.name,
              p.start_date,
              p.end_date,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', r.id,
                    'name', r.name,
                    'submissionCount', COALESCE(rsc.submission_count, 0)
                  )
                  ORDER BY r.name
                )
                  FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM model_card_projects p
       LEFT JOIN model_card_roles r ON r.project_id = p.id
       LEFT JOIN role_submission_counts rsc ON rsc.project_id = p.id AND rsc.role_id = r.id
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.name ASC`
    );
    res.json({ projects: rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/projects', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) throw new Error('项目名称必填');
    await syncProjectDir({ action: 'mkdir', projectName: name });
    const { rows } = await pool.query(
      `INSERT INTO model_card_projects (name, start_date, end_date, intro, disk_dir, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name, req.body.startDate || null, req.body.endDate || null, cleanName(req.body.intro), projectDiskDir(name), req.admin.id]
    );
    res.json({ project: rows[0] });
  } catch (error) {
    next(error);
  }
});

app.put('/api/admin/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) throw new Error('项目名称必填');
    const current = await pool.query('SELECT name, created_by FROM model_card_projects WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) throw new Error('项目不存在');
    if (!canMaintainProject(req.admin, current.rows[0])) {
      res.status(403).json({ error: '只能编辑自己创建的项目' });
      return;
    }

    if (current.rows[0].name !== name) {
      await syncProjectDir({
        action: 'rename',
        oldProjectName: current.rows[0].name,
        projectName: name,
      });
    } else {
      await syncProjectDir({ action: 'mkdir', projectName: name });
    }

    const { rows } = await pool.query(
      `UPDATE model_card_projects
       SET name=$2, start_date=$3, end_date=$4, intro=$5, disk_dir=$6, updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [req.params.id, name, req.body.startDate || null, req.body.endDate || null, cleanName(req.body.intro), projectDiskDir(name)]
    );
    res.json({ project: rows[0] });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/expired-projects', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const params = [];
    const ownerClause = req.admin.isSuperAdmin ? '' : 'AND created_by = $1';
    if (!req.admin.isSuperAdmin) params.push(req.admin.id);
    const { rows } = await client.query(
      `SELECT id, name, end_date
       FROM model_card_projects
       WHERE end_date IS NOT NULL
         AND end_date <= CURRENT_DATE - INTERVAL '3 months'
         ${ownerClause}
       ORDER BY end_date ASC, id ASC
       FOR UPDATE`,
      params
    );
    const deletedProjects = [];
    for (const project of rows) {
      deletedProjects.push(await deleteProjectRecord(client, project));
    }
    await client.query('COMMIT');
    transactionOpen = false;

    const syncedProjects = [];
    for (const project of deletedProjects) {
      syncedProjects.push(await syncDeletedProjectDir(project));
    }
    const dirSyncFailed = syncedProjects.filter((project) => !project.dirSynced);
    res.json({
      ok: true,
      count: syncedProjects.length,
      projects: syncedProjects,
      warning: dirSyncFailed.length
        ? `${dirSyncFailed.length} 个项目已从系统删除，但 n8n 项目目录未同步清理`
        : '',
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/admin/projects/:id', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const { rows } = await client.query('SELECT id, name, created_by FROM model_card_projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows[0]) throw new Error('项目不存在');
    if (!canMaintainProject(req.admin, rows[0])) {
      res.status(403).json({ error: '只能删除自己创建的项目' });
      await client.query('ROLLBACK');
      transactionOpen = false;
      return;
    }

    const deletedProject = await deleteProjectRecord(client, rows[0]);
    await client.query('COMMIT');
    transactionOpen = false;
    const syncedProject = await syncDeletedProjectDir(deletedProject);

    res.json({
      ok: true,
      project: syncedProject,
      warning: syncedProject.dirSynced ? '' : '项目已从系统删除，但 n8n 项目目录未同步清理',
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/admin/projects/:id/roles', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) throw new Error('职别名称必填');
    const project = await pool.query('SELECT id, created_by FROM model_card_projects WHERE id = $1', [req.params.id]);
    if (!project.rows[0]) throw new Error('项目不存在');
    if (!canMaintainProject(req.admin, project.rows[0])) {
      res.status(403).json({ error: '只能维护自己创建项目的职别' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO model_card_roles (project_id, name) VALUES ($1,$2) RETURNING *`,
      [req.params.id, name]
    );
    res.json({ role: rows[0] });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/roles/:id', requireAdmin, async (req, res, next) => {
  try {
    const role = await pool.query(
      `SELECT r.id, p.created_by
       FROM model_card_roles r
       JOIN model_card_projects p ON p.id = r.project_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!role.rows[0]) throw new Error('职别不存在');
    if (!canMaintainProject(req.admin, role.rows[0])) {
      res.status(403).json({ error: '只能维护自己创建项目的职别' });
      return;
    }
    await pool.query('DELETE FROM model_card_roles WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions', requireAdmin, async (req, res, next) => {
  try {
    const { params, where } = submissionFilters(req.query);
    const { rows } = await pool.query(
      dedupedSubmissionsSql(
        'id, project_name, person_name, role_name, phone, wechat, pptx_url, pptx_disk_path, pptx_file_name, status, submitted_at',
        where
      ),
      params
    );
    rows.forEach((row) => {
      row.pptx_url = absoluteSiteUrl(row.pptx_url);
    });
    res.json({ submissions: rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/submissions/merge-pptx', requireAdmin, async (req, res, next) => {
  try {
    cleanupMergedPptxJobs();
    const { params, where } = submissionFilters(req.body || {});
    const { rows } = await pool.query(
      dedupedSubmissionsSql(
        'id, project_name, role_name, person_name, pptx_file_name, pptx_base64, submitted_at',
        where,
        'submitted_at ASC, id ASC',
        [`status = 'done'`, `pptx_base64 IS NOT NULL`]
      ),
      params
    );
    if (!rows.length) throw new Error('当前查询结果没有可合并的 PPTX 文件');
    const result = await mergePptxRows(rows);
    res.json({
      ...result,
      downloadUrl: `/api/admin/submissions/merge-pptx/${result.token}/download`,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions/merge-pptx/:token/download', requireAdmin, async (req, res, next) => {
  try {
    cleanupMergedPptxJobs();
    const job = mergedPptxJobs.get(req.params.token);
    if (!job || !fs.existsSync(job.filePath)) {
      res.status(404).json({ error: '合并文件不存在或已过期，请重新合并' });
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName)}`);
    res.sendFile(job.filePath);
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions/export', requireAdmin, async (req, res, next) => {
  try {
    const { params, where } = submissionFilters(req.query);
    let exportBaseName = 'model-card-submissions';
    if (req.query.projectId) {
      const project = await pool.query('SELECT name FROM model_card_projects WHERE id = $1', [req.query.projectId]);
      if (project.rows[0]?.name) exportBaseName = `${project.rows[0].name}-报名清单`;
    }
    const { rows } = await pool.query(
      dedupedSubmissionsSql(
        `project_name AS 项目名称, person_name AS 姓名, role_name AS 职别,
         phone AS 联系电话, wechat AS 微信号, pptx_url AS "PPTX 文件 Url 下载位置",
         submitted_at AS 上传时间`,
        where
      ),
      params
    );
    rows.forEach((row) => {
      row['PPTX 文件 Url 下载位置'] = absoluteSiteUrl(row['PPTX 文件 Url 下载位置']);
    });
    if (!req.query.projectId) {
      const projectNames = [...new Set(rows.map((row) => row['项目名称']).filter(Boolean))];
      exportBaseName = projectNames.length === 1 ? `${projectNames[0]}-报名清单` : '全部项目-报名清单';
    }
    const workbook = await rowsToExcelWorkbook(rows);
    const fileName = `${excelFileName(exportBaseName)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(workbook);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === '23505' && error.constraint === 'model_card_admins_username_key') {
    res.status(400).json({ error: '登录名已存在，请换一个登录名' });
    return;
  }
  res.status(400).json({ error: error.message || '请求失败' });
});

const port = Number(process.env.PORT || 3051);
await initDb();
await ensureDefaultAdmin();
await backfillProjectCreators();
await restoreQueuedSubmissionJobs();
app.listen(port, () => {
  console.log(`model-card portal listening on port ${port}`);
});
