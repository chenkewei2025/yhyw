const loginPanel = document.querySelector('#loginPanel');
const adminPanel = document.querySelector('#adminPanel');
const loginForm = document.querySelector('#loginForm');
const loginStatus = document.querySelector('#loginStatus');
const logoutBtn = document.querySelector('#logoutBtn');
const currentAdminName = document.querySelector('#currentAdminName');
const openPasswordDialogBtn = document.querySelector('#openPasswordDialogBtn');
const openUserDialogBtn = document.querySelector('#openUserDialogBtn');
const passwordDialog = document.querySelector('#passwordDialog');
const passwordForm = document.querySelector('#passwordForm');
const passwordStatus = document.querySelector('#passwordStatus');
const userDialog = document.querySelector('#userDialog');
const userForm = document.querySelector('#userForm');
const userList = document.querySelector('#userList');
const projectForm = document.querySelector('#projectForm');
const projectList = document.querySelector('#projectList');
const roleForm = document.querySelector('#roleForm');
const roleProjectSelect = document.querySelector('#roleProjectSelect');
const roleList = document.querySelector('#roleList');
const filterProject = document.querySelector('#filterProject');
const filterRoleSelect = document.querySelector('#filterRoleSelect');
const filterRoleToggle = document.querySelector('#filterRoleToggle');
const filterRoleMenu = document.querySelector('#filterRoleMenu');
const submissionRows = document.querySelector('#submissionRows');
const projectRoleSummaryRows = document.querySelector('#projectRoleSummaryRows');
const projectRoleSummaryCount = document.querySelector('#projectRoleSummaryCount');
const cleanupExpiredProjectsBtn = document.querySelector('#cleanupExpiredProjectsBtn');
const mergePptxBtn = document.querySelector('#mergePptxBtn');
const downloadMergedPptxBtn = document.querySelector('#downloadMergedPptxBtn');

let projects = [];
let mergedPptxDownloadUrl = '';
let activeSubmissionFilters = {};
let selectedFilterRoles = [];
let submissionRequestId = 0;
let currentAdmin = null;
let users = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function api(url, options = {}) {
  return fetch(url, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  });
}

function showLoggedIn(loggedIn, admin = currentAdmin) {
  currentAdmin = loggedIn ? admin : null;
  loginPanel.classList.toggle('hidden', loggedIn);
  adminPanel.classList.toggle('hidden', !loggedIn);
  if (currentAdminName) currentAdminName.textContent = currentAdmin?.username || '-';
  if (openUserDialogBtn) openUserDialogBtn.classList.toggle('hidden', !currentAdmin?.isSuperAdmin);
}

function projectOptions(includeAll = false) {
  return `${includeAll ? '<option value="">全部项目</option>' : ''}${projects.map((project) => (
    `<option value="${escapeAttr(project.id)}">${escapeHtml(project.name)}</option>`
  )).join('')}`;
}

function projectOptionsFrom(items, includeAll = false) {
  return `${includeAll ? '<option value="">全部项目</option>' : ''}${items.map((project) => (
    `<option value="${escapeAttr(project.id)}">${escapeHtml(project.name)}</option>`
  )).join('')}`;
}

function roleOptions(projectId, includeAll = false) {
  const scopedProjects = projectId
    ? projects.filter((item) => String(item.id) === String(projectId))
    : projects;
  const options = scopedProjects.flatMap((project) => (project.roles || []).map((role) => {
    const label = projectId ? role.name : `${project.name} / ${role.name}`;
    return `<option value="${escapeAttr(role.id)}">${escapeHtml(label)}</option>`;
  }));
  return `${includeAll ? '<option value="">全部职别</option>' : ''}${options.join('')}`;
}

function filterRoleItems() {
  const scopedProjects = filterProject.value
    ? projects.filter((project) => String(project.id) === String(filterProject.value))
    : projects;
  return scopedProjects.flatMap((project) => (project.roles || []).map((role) => ({
    id: String(role.id),
    label: filterProject.value ? role.name : `${project.name} / ${role.name}`,
  })));
}

function formatProjectDate(project) {
  const start = project.start_date ? project.start_date.slice(0, 10) : '';
  const end = project.end_date ? project.end_date.slice(0, 10) : '';
  if (start && end) return `${start} 至 ${end}`;
  return start || end || '未设置';
}

function renderProjects() {
  const previousFilterProject = filterProject.value;
  projectList.innerHTML = projects.map((project) => `
    <div class="list-item">
      <div class="list-item-head">
        <div class="project-title">
          <strong>${escapeHtml(project.name)}</strong>
          <span class="creator-tag">创建者：${escapeHtml(project.created_by_username || '未记录')}</span>
        </div>
        <div class="row-actions">
          ${project.canEdit ? `<button class="secondary" data-edit-project="${project.id}">编辑</button>` : ''}
          ${project.canDelete ? `<button class="secondary" data-delete-project="${project.id}">删除</button>` : ''}
        </div>
      </div>
      <div class="meta">${formatProjectDate(project)}
${escapeHtml(project.intro || '暂无介绍')}</div>
    </div>
  `).join('') || '<p class="muted">暂无项目</p>';

  filterProject.innerHTML = projectOptions(true);
  if (projects.some((project) => String(project.id) === previousFilterProject)) {
    filterProject.value = previousFilterProject;
  }
  renderRoles();
  renderFilterRoles();
}

function renderUsers() {
  if (!currentAdmin?.isSuperAdmin) {
    users = [];
    if (userList) userList.innerHTML = '';
    return;
  }
  const manageableUsers = users.filter((user) => user.loginName !== 'admin');
  userList.innerHTML = manageableUsers.map((user) => `
    <div class="list-item">
      <div class="list-item-head">
        <strong>${escapeHtml(user.username)}</strong>
        <div class="row-actions">
          <button class="secondary" data-edit-user-name="${escapeAttr(user.id)}">改用户名</button>
          <button class="secondary" data-reset-user-password="${escapeAttr(user.id)}">改密码</button>
          <button class="secondary" data-delete-user="${escapeAttr(user.id)}">删除</button>
        </div>
      </div>
      <div class="meta">登录名：${escapeHtml(user.loginName || '')}</div>
    </div>
  `).join('') || '<p class="muted">暂无普通用户</p>';
}

function renderRoleProjectOptions(items) {
  const previousRoleProject = roleProjectSelect.value;
  roleProjectSelect.innerHTML = projectOptionsFrom(items, false);
  if (items.some((project) => String(project.id) === previousRoleProject)) {
    roleProjectSelect.value = previousRoleProject;
  } else if (items[0]) {
    roleProjectSelect.value = String(items[0].id);
  }
  roleProjectSelect.disabled = !items.length;
  roleForm.querySelector('button[type="submit"]').disabled = !items.length;
  renderRoles();
}

function renderRoles() {
  const project = projects.find((item) => String(item.id) === roleProjectSelect.value);
  roleList.innerHTML = (project?.roles || []).map((role) => `
    <div class="list-item">
      <div class="list-item-head">
        <strong>${escapeHtml(role.name)}</strong>
        ${project.canEdit ? `<button class="secondary" data-delete-role="${role.id}">删除</button>` : ''}
      </div>
      <div class="meta">${escapeHtml(project.name)}</div>
    </div>
  `).join('') || '<p class="muted">当前项目暂无职别</p>';
}

function renderProjectRoleSummary(items) {
  const roleCount = items.reduce((total, project) => total + (project.roles || []).length, 0);
  const submissionCount = items.reduce((total, project) => (
    total + (project.roles || []).reduce((roleTotal, role) => roleTotal + Number(role.submissionCount || 0), 0)
  ), 0);
  projectRoleSummaryCount.textContent = `${items.length} 个项目，${roleCount} 个职别，${submissionCount} 人报名`;
  const rows = items.flatMap((project) => {
    const roles = project.roles || [];
    if (!roles.length) {
      return [`
        <tr>
          <td>${escapeHtml(project.name)}</td>
          <td>${formatProjectDate(project)}</td>
          <td>暂无职别</td>
          <td>0</td>
        </tr>
      `];
    }
    return roles.map((role) => `
      <tr>
        <td>${escapeHtml(project.name)}</td>
        <td>${formatProjectDate(project)}</td>
        <td>${escapeHtml(role.name)}</td>
        <td>${Number(role.submissionCount || 0)}</td>
      </tr>
    `);
  });
  projectRoleSummaryRows.innerHTML = rows.join('') || '<tr><td colspan="4">暂无项目</td></tr>';
}

function renderFilterRoles() {
  const items = filterRoleItems();
  const itemIds = items.map((item) => item.id);
  selectedFilterRoles = selectedFilterRoles.filter((id) => itemIds.includes(id));

  const selectedLabels = items
    .filter((item) => selectedFilterRoles.includes(item.id))
    .map((item) => item.label);
  filterRoleToggle.textContent = selectedLabels.length ? selectedLabels.join('、') : '全部职别';

  filterRoleMenu.innerHTML = `
    <label class="multi-select-option">
      <input type="checkbox" data-role-id="" ${selectedFilterRoles.length ? '' : 'checked'}>
      <span>全部职别</span>
    </label>
    ${items.map((item) => `
      <label class="multi-select-option">
        <input type="checkbox" data-role-id="${escapeAttr(item.id)}" ${selectedFilterRoles.includes(item.id) ? 'checked' : ''}>
        <span>${escapeHtml(item.label)}</span>
      </label>
    `).join('') || '<div class="multi-select-empty">当前项目暂无职别</div>'}
  `;
  resetMergedPptx();
}

function setFilterRoleOpen(open) {
  filterRoleMenu.classList.toggle('hidden', !open);
  filterRoleToggle.setAttribute('aria-expanded', String(open));
}

function toggleFilterRole(roleId, checked) {
  if (!roleId) {
    selectedFilterRoles = [];
    renderFilterRoles();
    return;
  }

  const next = new Set(selectedFilterRoles);
  if (checked) {
    next.add(roleId);
  } else {
    next.delete(roleId);
  }
  selectedFilterRoles = [...next];
  renderFilterRoles();
}

function selectedFilterRoleIds() {
  return selectedFilterRoles;
}

function currentSubmissionFilters() {
  const filters = {};
  const roleIds = selectedFilterRoleIds();
  if (filterProject.value) filters.projectId = filterProject.value;
  if (roleIds.length) filters.roleId = roleIds.join(',');
  return filters;
}

function resetMergedPptx() {
  mergedPptxDownloadUrl = '';
  downloadMergedPptxBtn.disabled = true;
}

async function loadProjects() {
  const data = await api('/api/admin/projects');
  projects = data.projects || [];
  renderProjects();
}

async function loadUsers() {
  if (!currentAdmin?.isSuperAdmin) return;
  const data = await api('/api/admin/users');
  users = data.users || [];
  renderUsers();
}

async function loadProjectOptions() {
  const data = await api('/api/admin/project-options');
  renderRoleProjectOptions(data.projects || []);
}

async function loadProjectRoleSummary() {
  const data = await api('/api/admin/project-role-summary');
  renderProjectRoleSummary(data.projects || []);
}

async function loadSubmissions() {
  const requestId = ++submissionRequestId;
  activeSubmissionFilters = currentSubmissionFilters();
  const params = new URLSearchParams(activeSubmissionFilters);
  const data = await api(`/api/admin/submissions?${params.toString()}`);
  if (requestId !== submissionRequestId) return;
  submissionRows.innerHTML = (data.submissions || []).map((row) => `
    <tr>
      <td>${escapeHtml(row.project_name)}</td>
      <td>${escapeHtml(row.person_name)}</td>
      <td>${escapeHtml(row.role_name)}</td>
      <td>${escapeHtml(row.phone)}</td>
      <td>${escapeHtml(row.wechat || '')}</td>
      <td>${row.pptx_url ? `<a href="${escapeAttr(row.pptx_url)}">${escapeHtml(row.pptx_file_name || '下载')}</a>` : escapeHtml(row.status)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6">暂无报名记录</td></tr>';
  resetMergedPptx();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    loginStatus.textContent = '正在登录...';
    loginStatus.classList.remove('error');
    const body = Object.fromEntries(new FormData(loginForm).entries());
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(body) });
    loginStatus.textContent = '';
    showLoggedIn(true, data.admin);
    await loadUsers();
    await loadProjects();
    await loadProjectOptions();
    await loadProjectRoleSummary();
    await loadSubmissions();
  } catch (error) {
    loginStatus.textContent = error.message;
    loginStatus.classList.add('error');
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' });
  showLoggedIn(false);
});

openPasswordDialogBtn.addEventListener('click', () => {
  passwordStatus.textContent = '';
  passwordStatus.classList.remove('error');
  passwordDialog.showModal();
});

openUserDialogBtn.addEventListener('click', async () => {
  try {
    await loadUsers();
    userDialog.showModal();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector(`#${button.dataset.closeDialog}`)?.close();
  });
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    passwordStatus.textContent = '正在保存...';
    passwordStatus.classList.remove('error');
    const data = Object.fromEntries(new FormData(passwordForm).entries());
    await api(`/api/admin/users/${currentAdmin.id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password: data.password }),
    });
    passwordForm.reset();
    passwordStatus.textContent = '密码已更新';
    setTimeout(() => passwordDialog.close(), 500);
  } catch (error) {
    passwordStatus.textContent = error.message;
    passwordStatus.classList.add('error');
  }
});

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(userForm).entries());
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    userForm.reset();
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
});

userList.addEventListener('click', async (event) => {
  const editNameId = event.target.dataset.editUserName;
  const resetId = event.target.dataset.resetUserPassword;
  const deleteId = event.target.dataset.deleteUser;

  if (editNameId) {
    const user = users.find((item) => String(item.id) === String(editNameId));
    const username = prompt(`请输入 ${user?.loginName || '该用户'} 的用户名`, user?.username || '');
    if (!username) return;
    try {
      await api(`/api/admin/users/${editNameId}/display-name`, {
        method: 'PUT',
        body: JSON.stringify({ username }),
      });
      await loadUsers();
      await loadProjects();
    } catch (error) {
      alert(error.message);
    }
  }

  if (resetId) {
    const user = users.find((item) => String(item.id) === String(resetId));
    const password = prompt(`请输入 ${user?.username || '该用户'} 的新密码，至少 8 位`);
    if (!password) return;
    try {
      await api(`/api/admin/users/${resetId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      });
      alert('密码已更新');
    } catch (error) {
      alert(error.message);
    }
  }

  if (deleteId) {
    const user = users.find((item) => String(item.id) === String(deleteId));
    if (!confirm(`确认删除用户 ${user?.username || ''}？该用户创建的项目会保留，但创建人会显示为未记录。`)) return;
    try {
      await api(`/api/admin/users/${deleteId}`, { method: 'DELETE' });
      await loadUsers();
      await loadProjects();
    } catch (error) {
      alert(error.message);
    }
  }
});

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(projectForm).entries());
  const id = data.id;
  delete data.id;
  await api(id ? `/api/admin/projects/${id}` : '/api/admin/projects', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(data),
  });
  projectForm.reset();
  projectForm.elements.id.value = '';
  await loadProjects();
  await loadProjectOptions();
  await loadProjectRoleSummary();
});

document.querySelector('#resetProjectBtn').addEventListener('click', () => {
  projectForm.reset();
  projectForm.elements.id.value = '';
});

cleanupExpiredProjectsBtn.addEventListener('click', async () => {
  if (!confirm('确认删除结束日期已超过 3 个月的项目？会同时删除项目职别、报名清单和生成的 pptx 文件。')) return;
  try {
    cleanupExpiredProjectsBtn.disabled = true;
    const data = await api('/api/admin/expired-projects', { method: 'DELETE' });
    alert(`已清理 ${data.count || 0} 个过期项目${data.warning ? `\n${data.warning}` : ''}`);
    await loadProjects();
    await loadProjectOptions();
    await loadProjectRoleSummary();
    await loadSubmissions();
  } catch (error) {
    alert(error.message);
  } finally {
    cleanupExpiredProjectsBtn.disabled = false;
  }
});

projectList.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const editId = button.dataset.editProject;
  const deleteId = button.dataset.deleteProject;
  if (editId) {
    const project = projects.find((item) => String(item.id) === editId);
    if (!project) return;
    projectForm.elements.id.value = project.id;
    projectForm.elements.name.value = project.name;
    projectForm.elements.startDate.value = project.start_date ? project.start_date.slice(0, 10) : '';
    projectForm.elements.endDate.value = project.end_date ? project.end_date.slice(0, 10) : '';
    projectForm.elements.intro.value = project.intro || '';
  }
  if (deleteId && confirm('删除项目，同时删除本项目的职别记录和生成的pptx文件和清单')) {
    try {
      button.disabled = true;
      const data = await api(`/api/admin/projects/${deleteId}`, { method: 'DELETE' });
      await loadProjects();
      await loadProjectOptions();
      await loadProjectRoleSummary();
      await loadSubmissions();
      if (data.warning) alert(data.warning);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }
});

roleProjectSelect.addEventListener('change', renderRoles);

roleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(roleForm).entries());
  await api(`/api/admin/projects/${data.projectId}/roles`, {
    method: 'POST',
    body: JSON.stringify({ name: data.name }),
  });
  roleForm.elements.name.value = '';
  await loadProjects();
  await loadProjectOptions();
  await loadProjectRoleSummary();
});

roleList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-delete-role]');
  const id = button?.dataset.deleteRole;
  if (!id) return;
  if (!confirm('确认删除该职别？会同步删除该项目该职别已生成的 PPTX 文件，并清空报名记录中的 PPTX 下载信息。')) return;

  try {
    button.disabled = true;
    const data = await api(`/api/admin/roles/${id}`, { method: 'DELETE' });
    await loadProjects();
    await loadProjectOptions();
    await loadProjectRoleSummary();
    await loadSubmissions();
    const cleanup = data.pptxCleanup || {};
    alert(`职别已删除，已清理 ${cleanup.deletedFileCount || 0} 个 PPTX 文件。`);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

filterProject.addEventListener('change', async () => {
  renderFilterRoles();
  resetMergedPptx();
  await loadSubmissions();
});
filterRoleToggle.addEventListener('click', () => {
  setFilterRoleOpen(filterRoleMenu.classList.contains('hidden'));
});
filterRoleMenu.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-role-id]');
  if (!input) return;
  toggleFilterRole(input.dataset.roleId, input.checked);
  loadSubmissions().catch((error) => alert(error.message));
});
document.addEventListener('click', (event) => {
  if (!filterRoleSelect.contains(event.target)) setFilterRoleOpen(false);
});
document.querySelector('#searchBtn').addEventListener('click', loadSubmissions);
document.querySelector('#exportBtn').addEventListener('click', () => {
  const params = new URLSearchParams(currentSubmissionFilters());
  window.location.href = `/api/admin/submissions/export?${params.toString()}`;
});
mergePptxBtn.addEventListener('click', async () => {
  try {
    mergePptxBtn.disabled = true;
    downloadMergedPptxBtn.disabled = true;
    const data = await api('/api/admin/submissions/merge-pptx', {
      method: 'POST',
      body: JSON.stringify(activeSubmissionFilters),
    });
    mergedPptxDownloadUrl = data.downloadUrl;
    downloadMergedPptxBtn.disabled = false;
    alert(`已合并 ${data.count} 个 PPTX 文件`);
  } catch (error) {
    alert(error.message);
  } finally {
    mergePptxBtn.disabled = false;
  }
});
downloadMergedPptxBtn.addEventListener('click', () => {
  if (mergedPptxDownloadUrl) window.location.href = mergedPptxDownloadUrl;
});

api('/api/admin/me')
  .then(async (data) => {
    showLoggedIn(data.loggedIn, data.admin);
    if (data.loggedIn) {
      await loadUsers();
      await loadProjects();
      await loadProjectOptions();
      await loadProjectRoleSummary();
      await loadSubmissions();
    }
  })
  .catch(() => showLoggedIn(false));
