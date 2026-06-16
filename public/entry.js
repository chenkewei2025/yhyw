const projectSelect = document.querySelector('#projectSelect');
const roleSelect = document.querySelector('#roleSelect');
const projectIntro = document.querySelector('#projectIntro');
const projectCountdown = document.querySelector('#projectCountdown');
const form = document.querySelector('#entryForm');
const statusEl = document.querySelector('#status');
const downloadBtn = document.querySelector('#downloadBtn');
const submitBtn = document.querySelector('#submitBtn');
const otherPhotosInput = document.querySelector('#otherPhotosInput');
const chooseOtherPhotoBtn = document.querySelector('#chooseOtherPhotoBtn');
const clearOtherPhotosBtn = document.querySelector('#clearOtherPhotosBtn');
const otherPhotosNames = document.querySelector('#otherPhotosNames');
const phoneInput = form.elements.phone;
const successDialog = document.querySelector('#successDialog');
const successDialogClose = document.querySelector('#successDialogClose');
const successFields = {
  projectName: document.querySelector('#successProjectName'),
  startDate: document.querySelector('#successStartDate'),
  endDate: document.querySelector('#successEndDate'),
  personName: document.querySelector('#successPersonName'),
  roleName: document.querySelector('#successRoleName'),
};

let projects = [];
let roles = [];
let lastDownloadUrl = '';
let otherPhotoFiles = [];
let submissionStatusTimer = null;
let submissionLocked = false;
let countdownTimer = null;
let optionsRefreshTimer = null;

const allowedImageExtensions = ['.jpg', '.jpeg', '.bmp', '.gif', '.png'];
const allowedImageTypes = ['image/jpeg', 'image/pjpeg', 'image/bmp', 'image/x-ms-bmp', 'image/gif', 'image/png', 'image/x-png'];
const allowedImageFormatText = '.jpg、.jpeg、.bmp、.gif 或 .png';
const allowedVideoExtensions = ['.mp4', '.m4v', '.mov'];
const allowedVideoTypes = ['video/mp4', 'video/x-m4v', 'video/quicktime'];
const allowedVideoFormatText = '.mp4、.m4v 或 .mov 视频';
const mb = 1024 * 1024;

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function isAllowedImageFile(file) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return allowedImageTypes.includes(type)
    || allowedImageExtensions.some((extension) => name.endsWith(extension));
}

function isAllowedVideoFile(file) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return allowedVideoTypes.includes(type)
    || allowedVideoExtensions.some((extension) => name.endsWith(extension));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function stopSubmissionStatusPolling() {
  if (!submissionStatusTimer) return;
  clearTimeout(submissionStatusTimer);
  submissionStatusTimer = null;
}

function setSubmissionLocked(locked, label = '提交') {
  submissionLocked = locked;
  submitBtn.disabled = locked || !hasSelectableRole();
  submitBtn.textContent = label;
}

function isProjectClosed(project) {
  if (!project?.registration_deadline_at) return false;
  const deadline = new Date(project.registration_deadline_at);
  return !Number.isNaN(deadline.getTime()) && Date.now() > deadline.getTime();
}

function selectableProjects() {
  return projects.filter((project) => !isProjectClosed(project));
}

function selectedProject() {
  return projects.find((project) => String(project.id) === projectSelect.value);
}

function selectedRole() {
  return roles.find((role) => String(role.id) === roleSelect.value);
}

function hasSelectableRole() {
  const project = selectedProject();
  return Boolean(project && !isProjectClosed(project) && roles.some((role) => String(role.project_id) === projectSelect.value));
}

function formatProjectDate(project) {
  const start = project?.start_date ? project.start_date.slice(0, 10) : '';
  const end = project?.end_date ? project.end_date.slice(0, 10) : '';
  if (start && end) return `开始日期：${start}\n结束日期：${end}`;
  if (start) return `开始日期：${start}`;
  if (end) return `结束日期：${end}`;
  return '开始日期：未设置\n结束日期：未设置';
}

function renderProjectIntro(project) {
  if (!project) {
    projectIntro.textContent = '请选择报名项目';
    return;
  }
  projectIntro.textContent = `${formatProjectDate(project)}\n\n${project.intro || '暂无项目介绍'}`;
}

function formatDeadline(value) {
  if (!value) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  parts.push(`${String(hours).padStart(2, '0')}小时`);
  parts.push(`${String(minutes).padStart(2, '0')}分`);
  parts.push(`${String(seconds).padStart(2, '0')}秒`);
  return parts.join('');
}

function renderProjectCountdown(project) {
  if (!project) {
    projectCountdown.textContent = '请选择报名项目';
    projectCountdown.classList.remove('error');
    return;
  }
  if (!project.registration_deadline_at) {
    projectCountdown.textContent = '未设置报名截止时间';
    projectCountdown.classList.remove('error');
    return;
  }

  const deadline = new Date(project.registration_deadline_at);
  if (Number.isNaN(deadline.getTime())) {
    projectCountdown.textContent = '报名截止时间格式无效';
    projectCountdown.classList.add('error');
    return;
  }

  const remaining = deadline.getTime() - Date.now();
  if (remaining < 0) {
    projectCountdown.textContent = `报名已截止（截止时间：${formatDeadline(project.registration_deadline_at)}）`;
    projectCountdown.classList.add('error');
    return;
  }

  projectCountdown.textContent = `距离报名截止还有 ${formatCountdown(remaining)}（截止时间：${formatDeadline(project.registration_deadline_at)}）`;
  projectCountdown.classList.remove('error');
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const project = selectedProject();
    renderProjectCountdown(project);
    if (project && isProjectClosed(project)) {
      loadOptions({ showClosedAlert: true }).catch((error) => setStatus(error.message, true));
    }
  }, 1000);
}

function startOptionsRefresh() {
  if (optionsRefreshTimer) clearInterval(optionsRefreshTimer);
  optionsRefreshTimer = setInterval(() => {
    loadOptions({ silent: true }).catch(() => {});
  }, 30000);
}

function formatDateValue(value) {
  return value ? String(value).slice(0, 10) : '未设置';
}

function extractPersonName(introText) {
  const match = String(introText || '').match(/姓名[:：\s]*([^\n\r，,；;]+)/);
  return match?.[1]?.trim() || '未识别姓名';
}

function showSuccessDialog(data, formData) {
  const project = selectedProject();
  const role = selectedRole();
  const details = {
    projectName: data.projectName || project?.name || '未设置',
    startDate: formatDateValue(data.projectStartDate || project?.start_date),
    endDate: formatDateValue(data.projectEndDate || project?.end_date),
    personName: data.personName || extractPersonName(formData.get('introText')),
    roleName: data.roleName || role?.name || '未设置',
  };

  successFields.projectName.textContent = details.projectName;
  successFields.startDate.textContent = details.startDate;
  successFields.endDate.textContent = details.endDate;
  successFields.personName.textContent = details.personName;
  successFields.roleName.textContent = details.roleName;

  if (typeof successDialog.showModal === 'function') {
    successDialog.showModal();
    return;
  }

  alert(`报名成功\n项目名称：${details.projectName}\n项目开始时间：${details.startDate}\n项目结束时间：${details.endDate}\n姓名：${details.personName}\n职别：${details.roleName}`);
}

function renderProjects(preferredProjectId = '', options = {}) {
  const availableProjects = selectableProjects();
  projectSelect.innerHTML = availableProjects.map((project) => (
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`
  )).join('');
  if (preferredProjectId && availableProjects.some((project) => String(project.id) === String(preferredProjectId))) {
    projectSelect.value = preferredProjectId;
  }
  projectSelect.disabled = !availableProjects.length;
  roleSelect.disabled = !availableProjects.length;
  if (!availableProjects.length) {
    roleSelect.innerHTML = '<option value="">当前没有可报名项目</option>';
    submitBtn.disabled = true;
    renderProjectIntro(null);
    projectCountdown.textContent = '报名已截止';
    projectCountdown.classList.add('error');
    if (!options.silent) setStatus('当前没有可报名项目，报名已截止。', true);
    return;
  }
  renderRoles();
}

function renderRoles() {
  const project = selectedProject();
  if (project && isProjectClosed(project)) {
    roleSelect.innerHTML = '<option value="">报名已截止</option>';
    roleSelect.disabled = true;
    submitBtn.disabled = true;
    renderProjectIntro(project);
    renderProjectCountdown(project);
    setStatus('该项目报名已截止，请选择其他项目。', true);
    return;
  }
  const projectRoles = roles.filter((role) => String(role.project_id) === projectSelect.value);
  if (!projectRoles.length) {
    roleSelect.innerHTML = '<option value="">当前项目暂无职别</option>';
    roleSelect.disabled = true;
    submitBtn.disabled = true;
    renderProjectIntro(project);
    renderProjectCountdown(project);
    setStatus('当前项目还没有可报名职别，请先在后台维护。', true);
    return;
  }
  roleSelect.innerHTML = projectRoles.map((role) => (
    `<option value="${escapeHtml(role.id)}">${escapeHtml(role.name)}</option>`
  )).join('');
  roleSelect.disabled = false;
  setSubmissionLocked(submissionLocked);
  renderProjectIntro(project);
  renderProjectCountdown(project);
  setStatus('');
}

function renderOtherPhotos() {
  otherPhotosNames.textContent = otherPhotoFiles.length
    ? otherPhotoFiles.map((file) => file.name).join('、')
    : '未选择照片';
}

function addOtherPhotos(files) {
  const fileList = [...files];
  const selected = fileList.filter(isAllowedImageFile);
  const rejected = fileList.length - selected.length;
  if (rejected) {
    setStatus(`已忽略 ${rejected} 个不支持的照片文件，请上传 ${allowedImageFormatText} 图片`, true);
  }
  if (!selected.length) return;
  otherPhotoFiles = [...otherPhotoFiles, ...selected].slice(-2);
  renderOtherPhotos();
  if (!rejected) {
    const hasLargePhoto = selected.some((file) => file.size > 6 * mb);
    setStatus(hasLargePhoto ? '超过 6M 的照片会自动压缩后提交。' : '');
  }
}

function validateFiles(formData) {
  const bestPhoto = form.elements.bestPhoto.files[0];
  const bestVideo = form.elements.bestVideo.files[0];
  const otherPhotos = otherPhotoFiles;
  const otherVideos = [...form.elements.otherVideos.files];
  const phone = normalizePhone(formData.get('phone'));

  if (!bestPhoto) throw new Error('最佳照片必填');
  if (!bestVideo) throw new Error('最佳视频必填');
  if (phone.length !== 11) throw new Error('联系电话请输入 11 位数字');
  if (!isAllowedImageFile(bestPhoto)) throw new Error(`最佳照片文件类型不支持，请上传 ${allowedImageFormatText} 图片`);
  if (!isAllowedVideoFile(bestVideo)) throw new Error(`最佳视频文件类型不支持，请上传 ${allowedVideoFormatText}`);
  if (otherPhotos.length > 2) throw new Error('剩余照片最多 2 张');
  if (otherVideos.length > 1) throw new Error('剩余视频最多 1 个');
  otherPhotos.forEach((file, index) => {
    if (!isAllowedImageFile(file)) throw new Error(`剩余照片${index + 1}文件类型不支持，请上传 ${allowedImageFormatText} 图片`);
  });
  otherVideos.forEach((file, index) => {
    if (!isAllowedVideoFile(file)) throw new Error(`剩余视频${index + 1}文件类型不支持，请上传 ${allowedVideoFormatText}`);
  });
  formData.delete('otherPhotos');
  formData.set('phone', phone);
  otherPhotos.forEach((file) => formData.append('otherPhotos', file, file.name));
  return formData;
}

function hasOversizedMedia() {
  const files = [
    form.elements.bestPhoto.files[0],
    form.elements.bestVideo.files[0],
    ...otherPhotoFiles,
    ...form.elements.otherVideos.files,
  ].filter(Boolean);
  return files.some((file) => {
    if (isAllowedImageFile(file)) return file.size > 6 * mb;
    if (isAllowedVideoFile(file)) return file.size > 30 * mb;
    return false;
  });
}

async function loadOptions(options = {}) {
  const previousProjectId = projectSelect.value;
  const response = await fetch('/api/public/options');
  const data = await response.json();
  projects = data.projects || [];
  roles = data.roles || [];
  if (!projects.length) {
    projectSelect.innerHTML = '<option value="">请先在后台维护项目</option>';
    roleSelect.innerHTML = '<option value="">请先在后台维护职别</option>';
    projectSelect.disabled = true;
    roleSelect.disabled = true;
    submitBtn.disabled = true;
    projectIntro.textContent = '当前项目表 model_card_projects 为空，请先登录后台新增项目和职别。';
    projectCountdown.textContent = '当前没有可报名项目';
    projectCountdown.classList.add('error');
    if (!options.silent) setStatus('当前没有可报名项目，请先在后台项目维护中新增项目。', true);
    return;
  }
  const availableProjects = selectableProjects();
  if (options.showClosedAlert && previousProjectId && !availableProjects.some((project) => String(project.id) === previousProjectId)) {
    alert('报名已截止');
  }
  renderProjects(previousProjectId, options);
  startCountdown();
}

async function pollSubmissionStatus(statusUrl, formData) {
  try {
    const response = await fetch(statusUrl);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '查询生成状态失败');

    if (data.status === 'done') {
      stopSubmissionStatusPolling();
      lastDownloadUrl = data.downloadUrl;
      if (!lastDownloadUrl) throw new Error('PPTX 已生成但缺少下载地址，请联系管理员');
      downloadBtn.disabled = !lastDownloadUrl;
      setSubmissionLocked(false);
      setStatus(`生成完成：${data.fileName || 'PPTX 文件'}`);
      showSuccessDialog(data, formData);
      return;
    }

    if (data.status === 'failed') {
      stopSubmissionStatusPolling();
      setSubmissionLocked(false);
      setStatus('报名失败：PPTX 生成失败，请联系管理员处理', true);
      return;
    }

    setStatus('PPTX 生成中，请稍候...');
    submissionStatusTimer = setTimeout(() => pollSubmissionStatus(statusUrl, formData), 2000);
  } catch (error) {
    stopSubmissionStatusPolling();
    setSubmissionLocked(false);
    setStatus('报名失败：PPTX 生成失败，请联系管理员处理', true);
  }
}

projectSelect.addEventListener('change', renderRoles);
phoneInput.addEventListener('input', () => {
  const phone = normalizePhone(phoneInput.value);
  if (phoneInput.value !== phone) phoneInput.value = phone;
});
chooseOtherPhotoBtn.addEventListener('click', () => {
  otherPhotosInput.click();
});
clearOtherPhotosBtn.addEventListener('click', () => {
  otherPhotoFiles = [];
  otherPhotosInput.value = '';
  renderOtherPhotos();
  otherPhotosInput.click();
});
otherPhotosInput.addEventListener('change', () => {
  addOtherPhotos(otherPhotosInput.files);
  otherPhotosInput.value = '';
});
downloadBtn.addEventListener('click', () => {
  if (lastDownloadUrl) window.location.href = lastDownloadUrl;
});
successDialogClose.addEventListener('click', () => {
  successDialog.close();
});
successDialog.addEventListener('click', (event) => {
  if (event.target === successDialog) successDialog.close();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submissionLocked) return;
  let submitted = false;
  try {
    stopSubmissionStatusPolling();
    setStatus('正在提交报名信息，请稍候...');
    setSubmissionLocked(true, '提交中...');
    downloadBtn.disabled = true;
    lastDownloadUrl = '';

    const project = selectedProject();
    if (!project || isProjectClosed(project)) {
      alert('报名已截止');
      throw new Error('报名已截止');
    }

    const formData = validateFiles(new FormData(form));
    if (hasOversizedMedia()) {
      setStatus('素材较大，正在压缩后提交，请稍候...');
    }
    const response = await fetch('/api/submissions', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '提交失败');

    submitted = true;
    setSubmissionLocked(true, '生成中...');
    setStatus('PPTX 生成中，请稍候...');
    pollSubmissionStatus(data.statusUrl, formData);
  } catch (error) {
    if (!submitted) setSubmissionLocked(false);
    setStatus(error.message, true);
  } finally {
    if (!submitted) setSubmissionLocked(false);
  }
});

loadOptions().catch((error) => setStatus(error.message, true));
startOptionsRefresh();
renderOtherPhotos();
