const STORAGE_KEY = "financeiro-lumeris-v3";
const LEGACY_STORAGE_KEYS = ["financeiro-lumeris-v2", "financeiro-lumeris-v1"];

// URL de implantação do Google Apps Script (Web App). Preencha depois de publicar o Code.gs
// na sua planilha para que todos os usuários passem a compartilhar os mesmos dados.
const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbw6UqQ8YH0jMLdvDfSumh6h8zZfBSh91NIOd6oqJo_DP5bgP88N8lLl25daHvwCUWSq/exec";
const SYNC_DEBOUNCE_MS = 1200;
let remoteUpdatedAt = "";
let syncTimer = null;

const AUTH_STORAGE_KEY = "financeiro-lumeris-session";
const MASTER_USERNAME = "adm";
const MASTER_INITIAL_PASSWORD = "7695988";

const today = new Date();
const todayIso = toIso(today);
const currentMonthStart = toIso(startOfMonth(today));
const currentMonthEnd = toIso(endOfMonth(today));

const state = loadState();

const els = {
  viewTitle: document.querySelector("#viewTitle"),
  currentPeriod: document.querySelector("#currentPeriod"),
  syncStatus: document.querySelector("#syncStatus"),
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginError: document.querySelector("#loginError"),
  loginSubmit: document.querySelector("#loginSubmit"),
  appShell: document.querySelector("#appShell"),
  navUsuarios: document.querySelector("#navUsuarios"),
  sessionUserName: document.querySelector("#sessionUserName"),
  sessionUserRole: document.querySelector("#sessionUserRole"),
  logoutBtn: document.querySelector("#logoutBtn"),
  userForm: document.querySelector("#userForm"),
  userId: document.querySelector("#userId"),
  userName: document.querySelector("#userName"),
  userUsername: document.querySelector("#userUsername"),
  userPassword: document.querySelector("#userPassword"),
  userRole: document.querySelector("#userRole"),
  userActive: document.querySelector("#userActive"),
  usersList: document.querySelector("#usersList"),
  navItems: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  transactionDialog: document.querySelector("#transactionDialog"),
  transactionForm: document.querySelector("#transactionForm"),
  transactionTitle: document.querySelector("#transactionTitle"),
  transactionId: document.querySelector("#transactionId"),
  transactionType: document.querySelector("#transactionType"),
  transactionPerson: document.querySelector("#transactionPerson"),
  transactionDescription: document.querySelector("#transactionDescription"),
  transactionCategory: document.querySelector("#transactionCategory"),
  transactionDreGroup: document.querySelector("#transactionDreGroup"),
  transactionDueDate: document.querySelector("#transactionDueDate"),
  transactionAmount: document.querySelector("#transactionAmount"),
  transactionStatus: document.querySelector("#transactionStatus"),
  transactionPaidDate: document.querySelector("#transactionPaidDate"),
  transactionProjectMode: document.querySelector("#transactionProjectMode"),
  transactionProject: document.querySelector("#transactionProject"),
  transactionProjectWrap: document.querySelector("#transactionProjectWrap"),
  transactionDirectProjectCost: document.querySelector("#transactionDirectProjectCost"),
  allocationBox: document.querySelector("#allocationBox"),
  allocationRows: document.querySelector("#allocationRows"),
  allocationTotal: document.querySelector("#allocationTotal"),
  transactionNotes: document.querySelector("#transactionNotes"),
  saleDialog: document.querySelector("#saleDialog"),
  saleForm: document.querySelector("#saleForm"),
  salePerson: document.querySelector("#salePerson"),
  saleDate: document.querySelector("#saleDate"),
  saleDescription: document.querySelector("#saleDescription"),
  saleCategory: document.querySelector("#saleCategory"),
  saleProject: document.querySelector("#saleProject"),
  saleTotal: document.querySelector("#saleTotal"),
  saleInstallments: document.querySelector("#saleInstallments"),
  saleFirstDueDate: document.querySelector("#saleFirstDueDate"),
  saleInterval: document.querySelector("#saleInterval"),
  saleCustomDaysWrap: document.querySelector("#saleCustomDaysWrap"),
  saleCustomDays: document.querySelector("#saleCustomDays"),
  saleDreGroup: document.querySelector("#saleDreGroup"),
  saleNotes: document.querySelector("#saleNotes"),
  installmentPreview: document.querySelector("#installmentPreview"),
  ofxFile: document.querySelector("#ofxFile"),
  bankSearch: document.querySelector("#bankSearch"),
  bankStatus: document.querySelector("#bankStatus"),
  bankDialog: document.querySelector("#bankDialog"),
  bankForm: document.querySelector("#bankForm"),
  bankMovementId: document.querySelector("#bankMovementId"),
  bankMovementSummary: document.querySelector("#bankMovementSummary"),
  bankCategory: document.querySelector("#bankCategory"),
  bankDreGroup: document.querySelector("#bankDreGroup"),
  bankProject: document.querySelector("#bankProject"),
  bankMatchTransaction: document.querySelector("#bankMatchTransaction"),
  bankNotes: document.querySelector("#bankNotes"),
  bankBalanceList: document.querySelector("#bankBalanceList"),
  projectForm: document.querySelector("#projectForm"),
  projectId: document.querySelector("#projectId"),
  projectName: document.querySelector("#projectName"),
  projectCustomer: document.querySelector("#projectCustomer"),
  projectStatus: document.querySelector("#projectStatus"),
  projectStartDate: document.querySelector("#projectStartDate"),
  projectEndDate: document.querySelector("#projectEndDate"),
  projectContractValue: document.querySelector("#projectContractValue"),
  projectExpectedCosts: document.querySelector("#projectExpectedCosts"),
  projectTargetMargin: document.querySelector("#projectTargetMargin"),
  projectNotes: document.querySelector("#projectNotes"),
  projectReportSelect: document.querySelector("#projectReportSelect"),
  personForm: document.querySelector("#personForm"),
  personId: document.querySelector("#personId"),
  personType: document.querySelector("#personType"),
  personName: document.querySelector("#personName"),
  personDocument: document.querySelector("#personDocument"),
  personContact: document.querySelector("#personContact"),
  reportStart: document.querySelector("#reportStart"),
  reportEnd: document.querySelector("#reportEnd"),
  dreBasis: document.querySelector("#dreBasis"),
  toast: document.querySelector("#toast"),
};

const viewNames = {
  dashboard: "Painel financeiro",
  receber: "Contas a receber",
  pagar: "Contas a pagar",
  vendas: "Vendas parceladas",
  projetos: "Projetos e centros de custo",
  banco: "Conciliação bancária",
  pessoas: "Clientes e fornecedores",
  relatorios: "Relatórios financeiros",
  usuarios: "Usuários",
};

const dreGroups = [
  { key: "receita_bruta", label: "Receita bruta", sign: 1 },
  { key: "deducoes", label: "Deduções", sign: -1 },
  { key: "custos", label: "Custos", sign: -1 },
  { key: "despesas_operacionais", label: "Despesas operacionais", sign: -1 },
  { key: "despesas_financeiras", label: "Despesas financeiras", sign: -1 },
  { key: "impostos", label: "Impostos", sign: -1 },
  { key: "outros", label: "Outros", sign: 1 },
];

boot();

async function boot() {
  bindEvents();
  setDefaultReportPeriod();
  renderAll();
  // Busca os dados remotos ANTES de semear o usuário master: initRemoteSync substitui
  // state.users por inteiro, então criar o master antes disso arriscaria ele ser
  // sobrescrito pela resposta remota antes do persist() (debounced) conseguir enviá-lo.
  await initRemoteSync();
  await ensureMasterUser();
  renderUsers();
  restoreSessionOrShowLogin();
  els.loginSubmit.disabled = false;
  els.loginSubmit.textContent = "Entrar";
}

function bindEvents() {
  els.loginForm.addEventListener("submit", handleLogin);
  els.logoutBtn.addEventListener("click", handleLogout);
  els.userForm.addEventListener("submit", saveUser);
  enhanceSearchableSelect(els.projectCustomer, { placeholder: "Buscar cliente…" });
  els.navItems.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelector("#newTransactionBtn").addEventListener("click", () => openTransactionDialog());
  document.querySelector("#newSaleBtn").addEventListener("click", openSaleDialog);
  document.querySelector("#newSaleInlineBtn").addEventListener("click", openSaleDialog);
  document.querySelector("#printBtn").addEventListener("click", () => window.print());
  document.querySelector("#exportJson").addEventListener("click", exportBackup);
  document.querySelector("#importJson").addEventListener("change", importBackup);
  els.ofxFile.addEventListener("change", importOfx);
  document.querySelector("#exportBankCsv").addEventListener("click", exportBankCsv);
  document.querySelector("#applyCurrentMonth").addEventListener("click", () => {
    setDefaultReportPeriod();
    renderAll();
  });

  [
    "#receberSearch",
    "#receberStatus",
    "#pagarSearch",
    "#pagarStatus",
    "#salesSearch",
    "#bankSearch",
    "#bankStatus",
    "#peopleSearch",
    "#categoryReportType",
    "#reportStart",
    "#reportEnd",
    "#dreBasis",
  ].forEach((selector) => document.querySelector(selector).addEventListener("input", renderAll));

  document.querySelectorAll("[data-export-csv]").forEach((button) => {
    button.addEventListener("click", () => exportCsv(button.dataset.exportCsv));
  });

  document.querySelectorAll("[data-export-report]").forEach((button) => {
    button.addEventListener("click", () => exportReport(button.dataset.exportReport));
  });

  els.transactionType.addEventListener("change", () => {
    hydratePersonOptions();
    hydrateStatusOptions();
    setDefaultDreGroup();
  });

  els.transactionStatus.addEventListener("change", () => {
    if (["recebido", "pago"].includes(els.transactionStatus.value) && !els.transactionPaidDate.value) {
      els.transactionPaidDate.value = todayIso;
    }
  });

  els.transactionProjectMode.addEventListener("change", renderAllocationControls);
  els.transactionAmount.addEventListener("input", renderAllocationTotal);
  document.querySelector("#addAllocationBtn").addEventListener("click", () => addAllocationRow());

  els.transactionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.transactionDialog.close();
      return;
    }
    saveTransaction();
  });

  ["input", "change"].forEach((eventName) => {
    [els.saleTotal, els.saleInstallments, els.saleFirstDueDate, els.saleInterval, els.saleCustomDays].forEach((input) => {
      input.addEventListener(eventName, renderInstallmentPreview);
    });
  });

  els.saleInterval.addEventListener("change", () => {
    els.saleCustomDaysWrap.classList.toggle("hidden", els.saleInterval.value !== "custom");
  });

  els.saleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.saleDialog.close();
      return;
    }
    saveSale();
  });

  els.bankForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.bankDialog.close();
      return;
    }
    saveBankClassification();
  });

  els.projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveProject();
  });

  document.querySelector("#projectSearch").addEventListener("input", renderProjects);
  els.projectReportSelect.addEventListener("input", renderProjectReports);
  document.querySelector("#exportProjectCsv").addEventListener("click", exportProjectsCsv);

  els.personForm.addEventListener("submit", (event) => {
    event.preventDefault();
    savePerson();
  });
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY) || LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
  if (saved) {
    return normalizeState(JSON.parse(saved));
  }

  return normalizeState({
    people: [
      { id: crypto.randomUUID(), type: "cliente", name: "Cliente Exemplo", document: "", contact: "financeiro@cliente.com" },
      { id: crypto.randomUUID(), type: "fornecedor", name: "Fornecedor Exemplo", document: "", contact: "(11) 99999-0000" },
    ],
    sales: [],
    projects: [],
    costCenters: [],
    bankAccounts: [],
    bankMovements: [],
    transactions: [],
    users: [],
  });
}

function normalizeState(data) {
  const normalized = {
    people: Array.isArray(data.people) ? data.people : [],
    sales: Array.isArray(data.sales) ? data.sales : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    costCenters: Array.isArray(data.costCenters) ? data.costCenters : [],
    bankAccounts: Array.isArray(data.bankAccounts) ? data.bankAccounts : [],
    bankMovements: Array.isArray(data.bankMovements) ? data.bankMovements : [],
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    users: Array.isArray(data.users) ? data.users : [],
  };

  normalized.users = normalized.users.map((item) => ({
    id: crypto.randomUUID(),
    name: "",
    username: "",
    passwordHash: "",
    salt: "",
    role: "usuario",
    active: true,
    createdAt: "",
    ...item,
  }));

  normalized.projects = normalized.projects.map((item) => ({
    id: crypto.randomUUID(),
    code: "",
    name: "",
    customerId: "",
    status: "ativo",
    startDate: "",
    endDate: "",
    contractValue: 0,
    expectedCosts: 0,
    targetMargin: 20,
    costCenterId: "",
    notes: "",
    ...item,
  }));

  normalized.costCenters = normalized.costCenters.map((item) => ({
    id: crypto.randomUUID(),
    projectId: "",
    code: "",
    name: "",
    active: true,
    ...item,
  }));

  normalized.transactions = normalized.transactions.map((item) => ({
    dreGroup: defaultDreGroup(item.type),
    saleId: "",
    installmentNumber: "",
    installmentTotal: "",
    bankMovementId: "",
    directProjectCost: false,
    projectId: "",
    allocations: [],
    ...item,
  }));
  normalized.transactions.forEach((item) => {
    item.allocations = normalizeAllocations(item, normalized.projects);
    item.projectId = item.allocations.length === 1 ? item.allocations[0].projectId : "";
  });

  normalized.bankMovements = normalized.bankMovements.map((item) => ({
    category: "",
    dreGroup: (item.signedAmount ?? item.amount) >= 0 ? "receita_bruta" : "despesas_operacionais",
    projectId: "",
    notes: "",
    transactionId: "",
    ...item,
  }));
  hydrateBankMovementNaturalKeys(normalized.bankMovements);

  normalized.bankAccounts = normalized.bankAccounts.map((item) => ({
    id: item.accountId || item.id || crypto.randomUUID(),
    accountKey: item.accountKey || `${item.bankId || "Banco"}-${item.accountId || item.id || ""}`,
    accountId: item.accountId || item.id || "",
    bankId: item.bankId || "Banco",
    balance: Number(item.balance || 0),
    balanceDate: item.balanceDate || "",
    source: item.source || "ofx",
    updatedAt: item.updatedAt || "",
    ...item,
  }));

  if (!normalized.bankAccounts.length && normalized.bankMovements.length) {
    const inferred = new Map();
    normalized.bankMovements.forEach((movement) => {
      const accountKey = `${movement.bankId || "Banco"}-${movement.accountId || ""}`;
      const account = inferred.get(accountKey) || {
        id: movement.accountId || accountKey,
        accountKey,
        accountId: movement.accountId || "",
        bankId: movement.bankId || "Banco",
        balance: 0,
        balanceDate: movement.date || "",
        source: "movements",
        updatedAt: movement.importedAt || "",
      };
      account.balance += movement.signedAmount || (movement.type === "entrada" ? movement.amount : -movement.amount);
      if ((movement.date || "") > (account.balanceDate || "")) {
        account.balanceDate = movement.date;
      }
      inferred.set(accountKey, account);
    });
    normalized.bankAccounts = [...inferred.values()];
  }

  return normalized;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleRemoteSync();
}

async function initRemoteSync() {
  if (!SHEETS_ENDPOINT) {
    setSyncStatus("Somente neste navegador (Sheets não configurado)", "offline");
    return;
  }

  setSyncStatus("Carregando dados compartilhados…", "syncing");
  try {
    const response = await fetch(SHEETS_ENDPOINT);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "Falha ao carregar");
    remoteUpdatedAt = result.updatedAt || "";
    if (result.data) {
      const remoteState = normalizeState(result.data);
      Object.assign(state, remoteState);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
    }
    setSyncStatus("Sincronizado com o Google Sheets", "ok");
  } catch (error) {
    console.error(error);
    setSyncStatus("Sem conexão com o Sheets — usando dados locais", "error");
  }
}

function scheduleRemoteSync() {
  if (!SHEETS_ENDPOINT) return;
  window.clearTimeout(syncTimer);
  setSyncStatus("Salvando alterações…", "syncing");
  syncTimer = window.setTimeout(pushToSheets, SYNC_DEBOUNCE_MS);
}

function pushToSheets() {
  fetch(SHEETS_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ data: state, baseUpdatedAt: remoteUpdatedAt }),
  })
    .then((response) => response.json())
    .then((result) => {
      if (!result.ok) {
        if (result.error === "conflict") {
          toast("Outra pessoa salvou dados mais novos. Recarregue a página antes de continuar.");
          setSyncStatus("Conflito — recarregue a página", "error");
          return;
        }
        throw new Error(result.error || "Falha ao salvar");
      }
      remoteUpdatedAt = result.updatedAt || "";
      setSyncStatus("Sincronizado com o Google Sheets", "ok");
    })
    .catch((error) => {
      console.error(error);
      setSyncStatus("Erro ao salvar no Sheets — dados mantidos localmente", "error");
    });
}

function setSyncStatus(text, kind) {
  if (!els.syncStatus) return;
  els.syncStatus.textContent = text;
  els.syncStatus.dataset.state = kind;
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${password}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureMasterUser() {
  if (state.users.length) return;
  const salt = randomSalt();
  const passwordHash = await hashPassword(MASTER_INITIAL_PASSWORD, salt);
  state.users.push({
    id: crypto.randomUUID(),
    name: "Administrador",
    username: MASTER_USERNAME,
    passwordHash,
    salt,
    role: "administrador",
    active: true,
    createdAt: new Date().toISOString(),
  });
  persist();
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function setSession(user) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ userId: user.id, username: user.username }));
}

function clearSession() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function currentSessionUser() {
  const session = getSession();
  if (!session) return null;
  const user = state.users.find((item) => item.id === session.userId && item.username === session.username);
  return user && user.active ? user : null;
}

function isAdmin() {
  return currentSessionUser()?.role === "administrador";
}

function roleLabel(role) {
  return role === "administrador" ? "Administrador" : "Usuário";
}

function restoreSessionOrShowLogin() {
  if (currentSessionUser()) {
    showApp();
  } else {
    clearSession();
    showLogin();
  }
}

function showApp() {
  els.loginScreen.classList.add("hidden");
  els.appShell.classList.remove("hidden");
  updateSessionUi();
  setView("dashboard");
}

function showLogin() {
  els.appShell.classList.add("hidden");
  els.loginScreen.classList.remove("hidden");
  els.loginPassword.value = "";
  els.loginError.textContent = "";
  els.loginUsername.focus();
}

function updateSessionUi() {
  const user = currentSessionUser();
  if (!user) return;
  els.sessionUserName.textContent = user.name || user.username;
  els.sessionUserRole.textContent = roleLabel(user.role);
  els.navUsuarios.classList.toggle("hidden", user.role !== "administrador");
}

async function handleLogin(event) {
  event.preventDefault();
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  const user = state.users.find((item) => item.username.toLowerCase() === username.toLowerCase());

  if (!user || !user.active) {
    els.loginError.textContent = "Usuário ou senha inválidos.";
    return;
  }

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    els.loginError.textContent = "Usuário ou senha inválidos.";
    return;
  }

  els.loginError.textContent = "";
  setSession(user);
  showApp();
}

function handleLogout() {
  clearSession();
  showLogin();
}

function renderUsers() {
  const users = [...state.users].sort((a, b) => a.username.localeCompare(b.username));
  els.usersList.innerHTML = users.length
    ? users.map((user) => `
      <article class="person-item">
        <strong><span>${escapeHtml(user.name || user.username)}</span><span>${roleLabel(user.role)}</span></strong>
        <span class="muted">@${escapeHtml(user.username)} · ${user.active ? "Ativo" : "Inativo"}</span>
        <div class="row-actions">
          <button type="button" data-user-action="edit" data-id="${user.id}">Editar</button>
          <button type="button" data-user-action="delete" data-id="${user.id}">Excluir</button>
        </div>
      </article>`).join("")
    : emptyMessage("Nenhum usuário cadastrado.");

  document.querySelectorAll("[data-user-action]").forEach((button) => {
    button.addEventListener("click", () => handleUserAction(button.dataset.userAction, button.dataset.id));
  });
}

async function saveUser(event) {
  event.preventDefault();
  const id = els.userId.value || crypto.randomUUID();
  const username = els.userUsername.value.trim();
  const password = els.userPassword.value;
  const existing = state.users.find((item) => item.id === id);

  const usernameTaken = state.users.some((item) => item.id !== id && item.username.toLowerCase() === username.toLowerCase());
  if (usernameTaken) {
    toast("Já existe um usuário com esse login.");
    return;
  }

  if (!existing && !password) {
    toast("Informe uma senha para o novo usuário.");
    return;
  }

  let passwordHash = existing?.passwordHash || "";
  let salt = existing?.salt || "";
  if (password) {
    salt = randomSalt();
    passwordHash = await hashPassword(password, salt);
  }

  const data = {
    id,
    name: els.userName.value.trim(),
    username,
    passwordHash,
    salt,
    role: els.userRole.value,
    active: els.userActive.checked,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  const index = state.users.findIndex((item) => item.id === id);
  if (index >= 0) state.users[index] = data;
  else state.users.push(data);

  els.userForm.reset();
  els.userId.value = "";
  els.userActive.checked = true;
  persist();
  renderUsers();
  updateSessionUi();
  toast("Usuário salvo.");
}

function handleUserAction(action, id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;

  if (action === "edit") {
    els.userId.value = user.id;
    els.userName.value = user.name;
    els.userUsername.value = user.username;
    els.userPassword.value = "";
    els.userRole.value = user.role;
    els.userActive.checked = user.active;
    return;
  }

  if (user.username === MASTER_USERNAME) {
    toast("O usuário master não pode ser excluído.");
    return;
  }

  if (getSession()?.userId === id) {
    toast("Você não pode excluir o próprio usuário logado.");
    return;
  }

  state.users = state.users.filter((item) => item.id !== id);
  persist();
  renderUsers();
  toast("Usuário excluído.");
}

const SEARCH_ICON_SVG = '<svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>';

function enhanceSearchableSelect(selectEl, { placeholder = "Buscar…" } = {}) {
  if (!selectEl || selectEl.dataset.searchEnhanced) return;
  selectEl.dataset.searchEnhanced = "1";
  selectEl.classList.add("hidden");

  const wrap = document.createElement("div");
  wrap.className = "searchable-select";

  const inputWrap = document.createElement("div");
  inputWrap.className = "searchable-select-input-wrap";
  inputWrap.innerHTML = SEARCH_ICON_SVG;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "searchable-select-input";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  inputWrap.appendChild(input);

  const optionsBox = document.createElement("div");
  optionsBox.className = "searchable-select-options hidden";

  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(inputWrap);
  wrap.appendChild(optionsBox);
  wrap.appendChild(selectEl);

  function getOptions() {
    return Array.from(selectEl.options).map((option) => ({ value: option.value, label: option.textContent }));
  }

  function syncInputFromSelect() {
    const selected = selectEl.options[selectEl.selectedIndex];
    input.value = selected ? selected.textContent : "";
  }

  function renderOptions(filterText) {
    const filter = filterText.trim().toLowerCase();
    const items = getOptions().filter((option) => option.label.toLowerCase().includes(filter));
    optionsBox.innerHTML = items.length
      ? items.map((option) => `<div class="searchable-select-option" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</div>`).join("")
      : `<div class="searchable-select-empty">Nenhum resultado</div>`;
  }

  function openOptions() {
    renderOptions(input.value);
    optionsBox.classList.remove("hidden");
  }

  function closeOptions() {
    optionsBox.classList.add("hidden");
  }

  input.addEventListener("focus", () => {
    input.select();
    openOptions();
  });

  input.addEventListener("input", () => {
    openOptions();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOptions();
      syncInputFromSelect();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = optionsBox.querySelector("[data-value]");
      if (first) selectOption(first.dataset.value);
    }
  });

  optionsBox.addEventListener("mousedown", (event) => {
    const target = event.target.closest("[data-value]");
    if (!target) return;
    event.preventDefault();
    selectOption(target.dataset.value);
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) {
      closeOptions();
      syncInputFromSelect();
    }
  });

  function selectOption(value) {
    selectEl.value = value;
    syncInputFromSelect();
    closeOptions();
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  syncInputFromSelect();
  selectEl._searchableRefresh = syncInputFromSelect;
}

function refreshSearchableSelect(selectEl) {
  selectEl?._searchableRefresh?.();
}

function normalizeAllocations(transaction, projects = state.projects) {
  const projectIds = new Set(projects.map((project) => project.id));
  const raw = Array.isArray(transaction.allocations) ? transaction.allocations : [];
  const valid = raw
    .filter((allocation) => allocation?.projectId && projectIds.has(allocation.projectId))
    .map((allocation) => ({
      projectId: allocation.projectId,
      amount: roundCurrency(Number(allocation.amount || 0)),
    }))
    .filter((allocation) => allocation.amount > 0);

  if (valid.length) return valid;
  if (transaction.projectId && projectIds.has(transaction.projectId)) {
    return [{ projectId: transaction.projectId, amount: roundCurrency(Number(transaction.amount || 0)) }];
  }
  return [];
}

function allocationTotal(allocations) {
  return roundCurrency((allocations || []).reduce((total, allocation) => total + Number(allocation.amount || 0), 0));
}

function validateAllocations(amount, allocations) {
  if (!allocations.length) return true;
  return Math.abs(allocationTotal(allocations) - roundCurrency(Number(amount || 0))) < 0.01;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function projectName(projectId) {
  return state.projects.find((project) => project.id === projectId)?.name || "Sem projeto";
}

function setDefaultReportPeriod() {
  els.reportStart.value = currentMonthStart;
  els.reportEnd.value = currentMonthEnd;
}

function setView(view) {
  if (view === "usuarios" && !isAdmin()) {
    toast("Acesso restrito a administradores.");
    view = "dashboard";
  }
  els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  els.views.forEach((section) => section.classList.toggle("active", section.id === view));
  els.viewTitle.textContent = viewNames[view];
}

function renderAll() {
  els.currentPeriod.textContent = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(today);
  renderDashboard();
  renderTransactionTables();
  renderSales();
  renderProjects();
  renderProjectReports();
  renderBank();
  renderPeople();
  renderReports();
  hydratePersonOptions();
  hydrateSalePeople();
  hydrateProjectOptions();
  hydrateStatusOptions();
}

function renderDashboard() {
  const receber = state.transactions.filter((item) => item.type === "receber");
  const pagar = state.transactions.filter((item) => item.type === "pagar");
  const receberAberto = sum(receber.filter((item) => item.status === "aberto"));
  const pagarAberto = sum(pagar.filter((item) => item.status === "aberto"));
  const receberVencido = sum(receber.filter(isOverdue));
  const pagarVencido = sum(pagar.filter(isOverdue));
  const realizadoMes = sum(state.transactions.filter(isPaidThisMonth).map(signedAmount));

  document.querySelector("#kpiReceberAberto").textContent = money(receberAberto);
  document.querySelector("#kpiPagarAberto").textContent = money(pagarAberto);
  document.querySelector("#kpiReceberVencido").textContent = `${money(receberVencido)} vencido`;
  document.querySelector("#kpiPagarVencido").textContent = `${money(pagarVencido)} vencido`;
  document.querySelector("#kpiSaldoPrevisto").textContent = money(receberAberto - pagarAberto);
  document.querySelector("#kpiRealizadoMes").textContent = money(realizadoMes);

  renderBankBalances();
  renderCashflowBars();
  renderUpcoming();
}

function renderBankBalances() {
  const accounts = latestBankAccounts();
  els.bankBalanceList.innerHTML = accounts.length
    ? accounts.map((account) => `
      <article class="bank-balance-item">
        <div>
          <strong>${escapeHtml(account.bankId)}</strong>
          <span class="muted">Conta ${escapeHtml(account.accountId || "não identificada")} · ${account.balanceDate ? formatDate(account.balanceDate) : "sem data"} · ${account.source === "ofx" ? "saldo do OFX" : "saldo dos movimentos"}</span>
        </div>
        <strong class="money">${money(account.balance)}</strong>
      </article>`).join("")
    : emptyMessage("Importe um arquivo OFX na aba Banco para exibir os saldos das contas.");
}

function latestBankAccounts() {
  const byAccount = new Map();
  state.bankAccounts.forEach((account) => {
    const key = account.accountKey || `${account.bankId}-${account.accountId}`;
    const previous = byAccount.get(key);
    if (!previous || (account.balanceDate || "") >= (previous.balanceDate || "")) {
      byAccount.set(key, account);
    }
  });

  return [...byAccount.values()].sort((a, b) => (b.balanceDate || "").localeCompare(a.balanceDate || ""));
}

function renderCashflowBars() {
  const months = Array.from({ length: 6 }, (_, index) => addMonths(startOfMonth(today), index));
  const rows = months.map((month) => {
    const key = monthKey(month);
    const tx = state.transactions.filter((item) => monthKey(parseDate(item.dueDate)) === key && item.status === "aberto");
    return {
      label: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(month),
      inTotal: sum(tx.filter((item) => item.type === "receber")),
      outTotal: sum(tx.filter((item) => item.type === "pagar")),
    };
  });
  const max = Math.max(1, ...rows.flatMap((row) => [row.inTotal, row.outTotal]));

  document.querySelector("#cashflowBars").innerHTML = rows.map((row) => {
    const inSize = Math.max(2, Math.round((row.inTotal / max) * 100));
    const outSize = Math.max(2, Math.round((row.outTotal / max) * 100));
    return `
      <div class="bar-row">
        <strong>${row.label}</strong>
        <div class="bar-track" style="--in:${inSize}%;--out:${outSize}%">
          <span class="bar-in" title="Entradas ${money(row.inTotal)}"></span>
          <span class="bar-out" title="Saídas ${money(row.outTotal)}"></span>
        </div>
        <span class="money">${money(row.inTotal - row.outTotal)}</span>
      </div>`;
  }).join("");
}

function renderUpcoming() {
  const upcoming = state.transactions
    .filter((item) => item.status === "aberto")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 8);

  document.querySelector("#upcomingList").innerHTML = upcoming.length
    ? upcoming.map((item) => `
      <article class="mini-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${item.type === "receber" ? "Receber" : "Pagar"}</span>
      </article>`).join("")
    : emptyMessage("Nenhum vencimento em aberto.");
}

function renderTransactionTables() {
  renderTransactionTable("receber");
  renderTransactionTable("pagar");
}

function renderTransactionTable(type) {
  const search = document.querySelector(`#${type}Search`).value.toLowerCase().trim();
  const statusFilter = document.querySelector(`#${type}Status`).value;
  const tbody = document.querySelector(`#${type}Table`);
  const colspan = type === "receber" ? 8 : 7;

  const rows = state.transactions
    .filter((item) => item.type === type)
    .filter((item) => matchesTransaction(item, search, statusFilter))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  tbody.innerHTML = rows.length
    ? rows.map((item) => transactionRow(item, type)).join("")
    : `<tr><td colspan="${colspan}">${emptyMessage("Nenhum lançamento encontrado.")}</td></tr>`;

  tbody.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => handleTransactionAction(button.dataset.action, button.dataset.id));
  });
}

function transactionRow(item, type) {
  const installmentCell = type === "receber" ? `<td>${installmentLabel(item)}</td>` : "";
  return `
    <tr>
      <td>${formatDate(item.dueDate)}</td>
      <td>${escapeHtml(personName(item.personId))}</td>
      <td>
        <strong>${escapeHtml(item.description)}</strong>
        <span class="muted block">${escapeHtml(transactionProjectLabel(item))}</span>
      </td>
      ${installmentCell}
      <td>${escapeHtml(item.category)}</td>
      <td>${statusBadge(item)}</td>
      <td class="money">${money(item.amount)}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="toggle" data-id="${item.id}">${item.status === "aberto" ? "Baixar" : "Reabrir"}</button>
          <button type="button" data-action="edit" data-id="${item.id}">Editar</button>
          <button type="button" data-action="delete" data-id="${item.id}">Excluir</button>
        </div>
      </td>
    </tr>`;
}

function matchesTransaction(item, search, statusFilter) {
  const haystack = `${item.description} ${item.category} ${personName(item.personId)} ${item.notes || ""} ${installmentLabel(item)}`.toLowerCase();
  const status = isOverdue(item) ? "vencido" : item.status;
  return (!search || haystack.includes(search)) && (statusFilter === "todos" || statusFilter === status);
}

function statusBadge(item) {
  const overdue = isOverdue(item);
  const label = overdue ? "Vencido" : statusLabel(item.status);
  const css = overdue ? "vencido" : item.status === "aberto" ? "aberto" : "baixado";
  return `<span class="status ${css}">${label}</span>`;
}

function transactionProjectLabel(transaction) {
  const allocations = normalizeAllocations(transaction);
  if (!allocations.length) return "Sem projeto";
  if (allocations.length === 1) return projectName(allocations[0].projectId);
  return `Rateio entre ${allocations.length} projetos`;
}

function handleTransactionAction(action, id) {
  const item = state.transactions.find((transaction) => transaction.id === id);
  if (!item) return;

  if (action === "edit") {
    openTransactionDialog(item);
    return;
  }

  if (action === "delete") {
    state.bankMovements
      .filter((movement) => movement.transactionId === id)
      .forEach((movement) => {
        movement.transactionId = "";
      });
    state.transactions = state.transactions.filter((transaction) => transaction.id !== id);
    persist();
    renderAll();
    toast("Lançamento excluído.");
    return;
  }

  if (action === "toggle") {
    item.status = item.status === "aberto" ? (item.type === "receber" ? "recebido" : "pago") : "aberto";
    item.paidDate = item.status === "aberto" ? "" : todayIso;
    persist();
    renderAll();
    toast("Status atualizado.");
  }
}

function renderSales() {
  const search = document.querySelector("#salesSearch").value.toLowerCase().trim();
  const sales = state.sales
    .filter((sale) => `${sale.description} ${sale.category} ${personName(sale.personId)}`.toLowerCase().includes(search))
    .sort((a, b) => b.saleDate.localeCompare(a.saleDate));

  document.querySelector("#salesTable").innerHTML = sales.length
    ? sales.map((sale) => saleRow(sale)).join("")
    : `<tr><td colspan="8">${emptyMessage("Nenhuma venda parcelada cadastrada.")}</td></tr>`;
}

function saleRow(sale) {
  const installments = state.transactions.filter((item) => item.saleId === sale.id);
  const received = sum(installments.filter((item) => item.status === "recebido"));
  const open = installments.filter((item) => item.status === "aberto").length;
  const status = open === 0 && installments.length > 0 ? "Recebida" : `${open} em aberto`;

  return `
    <tr>
      <td>${formatDate(sale.saleDate)}</td>
      <td>${escapeHtml(personName(sale.personId))}</td>
      <td>${escapeHtml(sale.description)}</td>
      <td>${sale.installments}x</td>
      <td>${escapeHtml(sale.category)}</td>
      <td class="money">${money(sale.total)}</td>
      <td class="money">${money(received)}</td>
      <td><span class="status ${open === 0 ? "baixado" : "aberto"}">${status}</span></td>
    </tr>`;
}

function openSaleDialog() {
  els.saleForm.reset();
  els.saleCategory.value = "Vendas";
  els.saleInstallments.value = 1;
  els.saleDate.value = todayIso;
  els.saleFirstDueDate.value = todayIso;
  els.saleCustomDaysWrap.classList.add("hidden");
  hydrateSalePeople();
  hydrateProjectOptions();
  renderInstallmentPreview();
  els.saleDialog.showModal();
}

function saveSale() {
  const total = Number(els.saleTotal.value);
  const installmentsCount = Number(els.saleInstallments.value);
  const installments = buildInstallments(total, installmentsCount, els.saleFirstDueDate.value, els.saleInterval.value, Number(els.saleCustomDays.value));
  const saleId = crypto.randomUUID();
  const sale = {
    id: saleId,
    personId: els.salePerson.value,
    saleDate: els.saleDate.value,
    description: els.saleDescription.value.trim(),
    category: els.saleCategory.value.trim(),
    projectId: els.saleProject.value,
    total,
    installments: installmentsCount,
    dreGroup: els.saleDreGroup.value,
    notes: els.saleNotes.value.trim(),
    createdAt: new Date().toISOString(),
  };

  state.sales.push(sale);
  installments.forEach((installment) => {
    state.transactions.push({
      id: crypto.randomUUID(),
      type: "receber",
      personId: sale.personId,
      description: `${sale.description} - Parcela ${installment.number}/${installmentsCount}`,
      category: sale.category,
      dreGroup: sale.dreGroup,
      dueDate: installment.dueDate,
      amount: installment.amount,
      status: "aberto",
      paidDate: "",
      notes: sale.notes,
      saleId,
      installmentNumber: installment.number,
      installmentTotal: installmentsCount,
      projectId: sale.projectId,
      allocations: sale.projectId ? [{ projectId: sale.projectId, amount: installment.amount }] : [],
      updatedAt: new Date().toISOString(),
    });
  });

  persist();
  renderAll();
  els.saleDialog.close();
  setView("vendas");
  toast("Venda parcelada cadastrada e parcelas geradas.");
}

function renderInstallmentPreview() {
  const total = Number(els.saleTotal.value);
  const installmentsCount = Number(els.saleInstallments.value);
  const firstDue = els.saleFirstDueDate.value;

  if (!total || !installmentsCount || !firstDue) {
    els.installmentPreview.innerHTML = emptyMessage("Informe valor, parcelas e primeiro vencimento para visualizar as parcelas.");
    return;
  }

  const installments = buildInstallments(total, installmentsCount, firstDue, els.saleInterval.value, Number(els.saleCustomDays.value));
  els.installmentPreview.innerHTML = `
    <strong>Prévia das parcelas</strong>
    <div class="preview-grid">
      ${installments.map((item) => `<span>${item.number}/${installmentsCount}</span><span>${formatDate(item.dueDate)}</span><strong>${money(item.amount)}</strong>`).join("")}
    </div>`;
}

function buildInstallments(total, count, firstDue, interval, customDays) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  const firstDate = parseDate(firstDue);

  return Array.from({ length: count }, (_, index) => {
    const amountCents = base + (index < remainder ? 1 : 0);
    return {
      number: index + 1,
      amount: amountCents / 100,
      dueDate: toIso(nextInstallmentDate(firstDate, index, interval, customDays)),
    };
  });
}

function nextInstallmentDate(firstDate, index, interval, customDays) {
  if (interval === "weekly") {
    return addDays(firstDate, index * 7);
  }
  if (interval === "custom") {
    return addDays(firstDate, index * Math.max(1, customDays || 30));
  }
  return addMonths(firstDate, index);
}

function renderProjects() {
  const search = document.querySelector("#projectSearch").value.toLowerCase().trim();
  const projects = state.projects
    .filter((project) => `${project.name} ${personName(project.customerId)} ${project.status}`.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));

  document.querySelector("#projectList").innerHTML = projects.length
    ? projects.map((project) => `
      <article class="person-item">
        <strong><span>${escapeHtml(projectLabel(project))}</span><span>${projectStatusLabel(project.status)}</span></strong>
        <span class="muted">${escapeHtml(personName(project.customerId))} · Centro: ${escapeHtml(costCenterName(project.costCenterId))}</span>
        <div class="row-actions">
          <button type="button" data-project-action="edit" data-id="${project.id}">Editar</button>
          <button type="button" data-project-action="view" data-id="${project.id}">Ver resultado</button>
        </div>
      </article>`).join("")
    : emptyMessage("Nenhum projeto cadastrado.");

  document.querySelectorAll("[data-project-action]").forEach((button) => {
    button.addEventListener("click", () => handleProjectAction(button.dataset.projectAction, button.dataset.id));
  });
}

function saveProject() {
  const id = els.projectId.value || crypto.randomUUID();
  const existing = state.projects.find((project) => project.id === id);
  const costCenterId = existing?.costCenterId || crypto.randomUUID();
  const project = {
    id,
    code: "",
    name: els.projectName.value.trim(),
    customerId: els.projectCustomer.value,
    status: els.projectStatus.value,
    startDate: els.projectStartDate.value,
    endDate: els.projectEndDate.value,
    contractValue: Number(els.projectContractValue.value || 0),
    expectedCosts: Number(els.projectExpectedCosts.value || 0),
    targetMargin: Number(els.projectTargetMargin.value || 0),
    costCenterId,
    notes: els.projectNotes.value.trim(),
  };

  const index = state.projects.findIndex((item) => item.id === id);
  if (index >= 0) state.projects[index] = project;
  else state.projects.push(project);

  upsertCostCenter(project);
  els.projectForm.reset();
  els.projectId.value = "";
  refreshSearchableSelect(els.projectCustomer);
  persist();
  renderAll();
  els.projectReportSelect.value = project.id;
  renderProjectReports();
  toast("Projeto e centro de custo salvos.");
}

function upsertCostCenter(project) {
  const data = {
    id: project.costCenterId,
    projectId: project.id,
    code: project.name,
    name: project.name,
    active: project.status !== "concluido",
  };
  const index = state.costCenters.findIndex((item) => item.id === data.id);
  if (index >= 0) state.costCenters[index] = data;
  else state.costCenters.push(data);
}

function handleProjectAction(action, id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;

  if (action === "edit") {
    els.projectId.value = project.id;
    els.projectName.value = project.name;
    els.projectCustomer.value = project.customerId;
    refreshSearchableSelect(els.projectCustomer);
    els.projectStatus.value = project.status;
    els.projectStartDate.value = project.startDate;
    els.projectEndDate.value = project.endDate;
    els.projectContractValue.value = project.contractValue;
    els.projectExpectedCosts.value = project.expectedCosts;
    els.projectTargetMargin.value = project.targetMargin;
    els.projectNotes.value = project.notes;
    return;
  }

  els.projectReportSelect.value = id;
  renderProjectReports();
}

function hydrateProjectOptions() {
  const projectOptions = state.projects.length
    ? state.projects.map((project) => `<option value="${project.id}">${escapeHtml(projectLabel(project))}</option>`).join("")
    : `<option value="">Cadastre um projeto primeiro</option>`;
  const optionalProjectOptions = `<option value="">Sem projeto</option>${projectOptions}`;

  els.transactionProject.innerHTML = projectOptions;
  els.saleProject.innerHTML = optionalProjectOptions;
  els.bankProject.innerHTML = optionalProjectOptions;
  els.projectReportSelect.innerHTML = optionalProjectOptions;
  els.projectCustomer.innerHTML = `<option value="">Sem cliente vinculado</option>${state.people
    .filter((person) => person.type === "cliente" || person.type === "ambos")
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join("")}`;
  refreshSearchableSelect(els.projectCustomer);
}

function projectLabel(project) {
  return project.name || project.code || "Projeto sem nome";
}

function projectStatusLabel(status) {
  return { ativo: "Ativo", orcamento: "Orçamento", concluido: "Concluído", pausado: "Pausado" }[status] || status;
}

function costCenterName(costCenterId) {
  return state.costCenters.find((item) => item.id === costCenterId)?.name || "Não criado";
}

function renderProjectReports() {
  const summaries = state.projects.map(projectSummary);
  const selectedId = els.projectReportSelect.value || state.projects[0]?.id || "";
  const selected = summaries.find((summary) => summary.project.id === selectedId);

  renderSelectedProjectSummary(selected);
  renderProjectComparison(summaries);
  renderProfitableProjects(summaries);
  renderLowMarginProjects(summaries);
  renderUnallocatedExpenses();
}

function projectSummary(project) {
  const allocations = projectAllocations(project.id);
  const revenueAllocations = allocations.filter((entry) => entry.transaction.type === "receber");
  const costAllocations = allocations.filter((entry) => entry.transaction.type === "pagar");
  const invoiced = sum(revenueAllocations.map((entry) => entry.amount));
  const received = sum(revenueAllocations.filter((entry) => entry.transaction.status === "recebido").map((entry) => entry.amount));
  const receivable = sum(revenueAllocations.filter((entry) => entry.transaction.status === "aberto").map((entry) => entry.amount));
  const costs = sum(costAllocations.map((entry) => entry.amount));
  const payable = sum(costAllocations.filter((entry) => entry.transaction.status === "aberto").map((entry) => entry.amount));
  const paid = sum(costAllocations.filter((entry) => entry.transaction.status === "pago").map((entry) => entry.amount));
  const grossResult = invoiced - costs;
  const marginPercent = invoiced ? (grossResult / invoiced) * 100 : 0;

  return {
    project,
    contracted: Number(project.contractValue || 0),
    invoiced,
    received,
    receivable,
    expectedCosts: Number(project.expectedCosts || 0),
    costs,
    payable,
    paid,
    grossResult,
    marginAmount: grossResult,
    marginPercent,
  };
}

function projectAllocations(projectId) {
  const transactionEntries = state.transactions.flatMap((transaction) => {
    const allocations = normalizeAllocations(transaction);
    return allocations
      .filter((allocation) => allocation.projectId === projectId)
      .map((allocation) => ({ transaction, amount: allocation.amount }));
  });

  const bankEntries = state.bankMovements
    .filter((movement) => movement.projectId === projectId && !movement.transactionId)
    .map((movement) => ({
      transaction: {
        type: movement.type === "entrada" ? "receber" : "pagar",
        status: movement.type === "entrada" ? "recebido" : "pago",
        category: movement.category || "Banco",
        description: movement.description,
        dueDate: movement.date,
        paidDate: movement.date,
      },
      amount: movement.amount,
    }));

  return [...transactionEntries, ...bankEntries];
}

function renderSelectedProjectSummary(summary) {
  if (!summary) {
    document.querySelector("#projectContracted").textContent = money(0);
    document.querySelector("#projectInvoiced").textContent = money(0);
    document.querySelector("#projectReceivedSmall").textContent = `${money(0)} recebido`;
    document.querySelector("#projectCosts").textContent = money(0);
    document.querySelector("#projectPaidSmall").textContent = `${money(0)} pago`;
    document.querySelector("#projectGrossResult").textContent = money(0);
    document.querySelector("#projectMarginSmall").textContent = "0,0% de margem";
    document.querySelector("#projectResultReport").innerHTML = emptyMessage("Cadastre um projeto para visualizar o resultado.");
    document.querySelector("#projectCategoryCosts").innerHTML = emptyMessage("Sem custos por categoria.");
    return;
  }

  document.querySelector("#projectContracted").textContent = money(summary.contracted);
  document.querySelector("#projectInvoiced").textContent = money(summary.invoiced);
  document.querySelector("#projectReceivedSmall").textContent = `${money(summary.received)} recebido · ${money(summary.receivable)} a receber`;
  document.querySelector("#projectCosts").textContent = money(summary.costs);
  document.querySelector("#projectPaidSmall").textContent = `${money(summary.paid)} pago · ${money(summary.payable)} a pagar`;
  document.querySelector("#projectGrossResult").textContent = money(summary.grossResult);
  document.querySelector("#projectMarginSmall").textContent = `${summary.marginPercent.toFixed(1)}% de margem`;

  document.querySelector("#projectResultReport").innerHTML = [
    ["Receita contratada", summary.contracted],
    ["Receita faturada", summary.invoiced],
    ["Receita recebida", summary.received],
    ["Saldo a receber", summary.receivable],
    ["Custos previstos", summary.expectedCosts],
    ["Custos realizados", summary.costs],
    ["Contas a pagar", summary.payable],
    ["Valores pagos", summary.paid],
    ["Resultado bruto", summary.grossResult],
    ["Margem do projeto", summary.marginAmount],
  ].map(([label, value]) => `
    <article class="dre-row">
      <span>${label}</span>
      <strong>${money(value)}</strong>
    </article>`).join("") + `
    <article class="dre-row dre-total">
      <span>Margem percentual</span>
      <strong>${summary.marginPercent.toFixed(1)}%</strong>
    </article>`;

  renderProjectCategoryCosts(summary.project.id);
}

function renderProjectCategoryCosts(projectId) {
  const rows = new Map();
  projectAllocations(projectId)
    .filter((entry) => entry.transaction.type === "pagar")
    .forEach((entry) => {
      const key = entry.transaction.category || "Sem categoria";
      const row = rows.get(key) || { category: key, total: 0, count: 0 };
      row.total += entry.amount;
      row.count += 1;
      rows.set(key, row);
    });

  const sorted = [...rows.values()].sort((a, b) => b.total - a.total);
  document.querySelector("#projectCategoryCosts").innerHTML = sorted.length
    ? sorted.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.category)}</span><span>${money(row.total)}</span></strong>
        <span class="muted">${row.count} lançamento(s)</span>
      </article>`).join("")
    : emptyMessage("Sem custos vinculados ao projeto.");
}

function renderProjectComparison(summaries) {
  document.querySelector("#projectComparisonTable").innerHTML = summaries.length
    ? summaries.map((summary) => `
      <tr>
        <td>${escapeHtml(projectLabel(summary.project))}</td>
        <td class="money">${money(summary.invoiced)}</td>
        <td class="money">${money(summary.costs)}</td>
        <td class="money">${money(summary.grossResult)}</td>
        <td>${summary.marginPercent.toFixed(1)}%</td>
        <td>${projectStatusLabel(summary.project.status)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6">${emptyMessage("Nenhum projeto cadastrado.")}</td></tr>`;
}

function renderProfitableProjects(summaries) {
  const rows = [...summaries].sort((a, b) => b.grossResult - a.grossResult).slice(0, 5);
  document.querySelector("#profitableProjects").innerHTML = rows.length
    ? rows.map((summary) => `
      <article class="report-item">
        <strong><span>${escapeHtml(projectLabel(summary.project))}</span><span>${money(summary.grossResult)}</span></strong>
        <span class="muted">${summary.marginPercent.toFixed(1)}% de margem</span>
      </article>`).join("")
    : emptyMessage("Nenhum projeto para comparar.");
}

function renderLowMarginProjects(summaries) {
  const rows = summaries
    .filter((summary) => summary.invoiced > 0 && summary.marginPercent < Number(summary.project.targetMargin || 0))
    .sort((a, b) => a.marginPercent - b.marginPercent);

  document.querySelector("#lowMarginProjects").innerHTML = rows.length
    ? rows.map((summary) => `
      <article class="report-item">
        <strong><span>${escapeHtml(projectLabel(summary.project))}</span><span>${summary.marginPercent.toFixed(1)}%</span></strong>
        <span class="muted">Meta: ${Number(summary.project.targetMargin || 0).toFixed(1)}% · Resultado ${money(summary.grossResult)}</span>
      </article>`).join("")
    : emptyMessage("Nenhum projeto abaixo da margem esperada.");
}

function renderUnallocatedExpenses() {
  const rows = state.transactions
    .filter((transaction) => transaction.type === "pagar" && !normalizeAllocations(transaction).length)
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
    .slice(0, 20);

  document.querySelector("#unallocatedExpenses").innerHTML = rows.length
    ? rows.map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${escapeHtml(item.category)} · ${statusLabel(item.status)}</span>
      </article>`).join("")
    : emptyMessage("Nenhuma despesa sem projeto vinculada.");
}

function exportProjectsCsv() {
  const rows = state.projects.map(projectSummary).map((summary) => [
    summary.project.name,
    personName(summary.project.customerId),
    projectStatusLabel(summary.project.status),
    summary.contracted,
    summary.invoiced,
    summary.received,
    summary.receivable,
    summary.expectedCosts,
    summary.costs,
    summary.payable,
    summary.paid,
    summary.grossResult,
    summary.marginPercent.toFixed(2),
  ]);
  downloadCsv("projetos-centro-custos.csv", [["projeto", "cliente", "status", "receita_contratada", "receita_faturada", "receita_recebida", "saldo_receber", "custos_previstos", "custos_realizados", "contas_pagar", "valores_pagos", "resultado", "margem_percentual"], ...rows]);
}

function importOfx(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseOfx(String(reader.result), file.name);
      upsertBankAccount(parsed.account);
      const existingKeys = new Set(state.bankMovements.flatMap((item) => [item.importKey, item.naturalKey].filter(Boolean)));
      const fresh = parsed.movements.filter((item) => !existingKeys.has(item.importKey) && !existingKeys.has(item.naturalKey));
      state.bankMovements.push(...fresh);
      persist();
      renderAll();
      setView("banco");
      toast(`${fresh.length} movimento(s) importado(s). ${parsed.movements.length - fresh.length} duplicado(s) ignorado(s).`);
    } catch {
      toast("Não foi possível ler o arquivo OFX.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function parseOfx(content, filename) {
  const normalized = content.replace(/\r/g, "");
  const accountId = tagValue(normalized, "ACCTID") || filename;
  const bankId = tagValue(normalized, "BANKID") || tagValue(normalized, "ORG") || "Banco";
  const accountKey = `${bankId}-${accountId}`;
  const hasBalanceAmount = Boolean(tagValue(normalized, "BALAMT"));
  const balanceAmount = Number((tagValue(normalized, "BALAMT") || "0").replace(",", "."));
  const balanceDate = parseOfxDate(tagValue(normalized, "DTASOF")) || latestOfxTransactionDate(normalized);
  const blocks = [...normalized.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CREDITCARDMSGSRSV1>|$)/gi)].map((match) => match[1]);

  if (!blocks.length) {
    throw new Error("OFX sem movimentos");
  }

  const occurrences = new Map();
  const movements = blocks.map((block) => {
    const amount = Number((tagValue(block, "TRNAMT") || "0").replace(",", "."));
    const date = parseOfxDate(tagValue(block, "DTPOSTED"));
    const memo = [tagValue(block, "NAME"), tagValue(block, "MEMO")].filter(Boolean).join(" - ") || "Movimento bancário";
    const documentNumber = tagValue(block, "CHECKNUM") || tagValue(block, "REFNUM") || "";
    const fitid = tagValue(block, "FITID");
    const type = amount >= 0 ? "entrada" : "saida";
    const naturalBaseKey = buildBankMovementNaturalKey(accountKey, {
      date,
      amount,
      documentNumber,
      description: memo,
      fitid,
    });
    const occurrence = (occurrences.get(naturalBaseKey) || 0) + 1;
    occurrences.set(naturalBaseKey, occurrence);
    const naturalKey = `${naturalBaseKey}-${occurrence}`;

    return {
      id: crypto.randomUUID(),
      importKey: naturalKey,
      naturalKey,
      fitid,
      accountId,
      bankId,
      filename,
      date,
      type,
      documentNumber,
      description: cleanText(memo),
      amount: Math.abs(amount),
      signedAmount: amount,
      category: "",
      dreGroup: type === "entrada" ? "receita_bruta" : "despesas_operacionais",
      notes: "",
      transactionId: "",
      importedAt: new Date().toISOString(),
    };
  }).filter((item) => item.date && item.amount > 0);

  const movementBalance = movements.reduce((total, item) => total + item.signedAmount, 0);

  return {
    account: {
      id: accountId,
      accountKey,
      accountId,
      bankId,
      balance: hasBalanceAmount && Number.isFinite(balanceAmount) ? balanceAmount : movementBalance,
      balanceDate,
      source: hasBalanceAmount ? "ofx" : "movements",
      filename,
      updatedAt: new Date().toISOString(),
    },
    movements,
  };
}

function upsertBankAccount(account) {
  const index = state.bankAccounts.findIndex((item) => (item.accountKey || `${item.bankId}-${item.accountId}`) === account.accountKey);
  if (index < 0) {
    state.bankAccounts.push(account);
    return;
  }

  const current = state.bankAccounts[index];
  if ((account.balanceDate || "") >= (current.balanceDate || "")) {
    state.bankAccounts[index] = { ...current, ...account };
  }
}

function latestOfxTransactionDate(content) {
  const dates = [...content.matchAll(/<DTPOSTED>([0-9]{8})/gi)].map((match) => parseOfxDate(match[1])).filter(Boolean);
  return dates.sort().at(-1) || "";
}

function buildBankMovementNaturalKey(accountKey, movement) {
  const amountInCents = Math.round(Number(movement.amount || 0) * 100);
  const parts = [
    accountKey,
    movement.date || "",
    amountInCents,
    movement.documentNumber || "",
    movement.fitid || "",
    normalizeKeyText(movement.description || ""),
  ];
  return parts.join("|");
}

function hydrateBankMovementNaturalKeys(movements) {
  const occurrences = new Map();
  movements.forEach((movement) => {
    const accountKey = movement.accountKey || `${movement.bankId || "Banco"}-${movement.accountId || ""}`;
    const naturalBaseKey = buildBankMovementNaturalKey(accountKey, {
      date: movement.date,
      amount: movement.signedAmount ?? movement.amount,
      documentNumber: movement.documentNumber,
      description: movement.description,
      fitid: movement.fitid,
    });
    const occurrence = (occurrences.get(naturalBaseKey) || 0) + 1;
    occurrences.set(naturalBaseKey, occurrence);
    movement.naturalKey = movement.naturalKey || `${naturalBaseKey}-${occurrence}`;
  });
}

function normalizeKeyText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tagValue(source, tag) {
  const match = source.match(new RegExp(`<${tag}>([^<\\n\\r]*)`, "i"));
  return match ? decodeOfx(match[1].trim()) : "";
}

function decodeOfx(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function parseOfxDate(value) {
  if (!value || value.length < 8) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function renderBank() {
  const movements = filteredBankMovements();
  const all = state.bankMovements;
  const totalIn = sum(all.filter((item) => item.type === "entrada"));
  const totalOut = sum(all.filter((item) => item.type === "saida"));
  const pending = all.filter((item) => bankStatus(item) === "pendente").length;

  document.querySelector("#bankInTotal").textContent = money(totalIn);
  document.querySelector("#bankOutTotal").textContent = money(totalOut);
  document.querySelector("#bankNetTotal").textContent = money(totalIn - totalOut);
  document.querySelector("#bankPendingCount").textContent = String(pending);
  document.querySelector("#bankInCount").textContent = `${all.filter((item) => item.type === "entrada").length} movimentos`;
  document.querySelector("#bankOutCount").textContent = `${all.filter((item) => item.type === "saida").length} movimentos`;

  document.querySelector("#bankTable").innerHTML = movements.length
    ? movements.map(bankRow).join("")
    : `<tr><td colspan="8">${emptyMessage("Nenhum movimento bancário encontrado.")}</td></tr>`;

  document.querySelectorAll("[data-bank-action]").forEach((button) => {
    button.addEventListener("click", () => handleBankAction(button.dataset.bankAction, button.dataset.id));
  });
}

function filteredBankMovements() {
  const search = els.bankSearch.value.toLowerCase().trim();
  const status = els.bankStatus.value;
  return state.bankMovements
    .filter((item) => {
      const haystack = `${item.description} ${item.bankId} ${item.accountId} ${item.documentNumber} ${item.category} ${projectName(item.projectId)}`.toLowerCase();
      return (!search || haystack.includes(search)) && (status === "todos" || bankStatus(item) === status);
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function bankRow(item) {
  return `
    <tr>
      <td>${formatDate(item.date)}</td>
      <td>${item.type === "entrada" ? "Entrada" : "Saída"}</td>
      <td>
        <strong>${escapeHtml(item.description)}</strong>
        <span class="muted block">${escapeHtml(item.bankId)} · ${escapeHtml(item.documentNumber || item.fitid)} · ${escapeHtml(item.projectId ? projectName(item.projectId) : "Sem projeto")}</span>
      </td>
      <td>${escapeHtml(item.category || "-")}</td>
      <td>${dreGroupLabel(item.dreGroup)}</td>
      <td>${bankStatusBadge(item)}</td>
      <td class="money">${money(item.amount)}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-bank-action="classify" data-id="${item.id}">Classificar</button>
          <button type="button" data-bank-action="unlink" data-id="${item.id}">Desfazer</button>
        </div>
      </td>
    </tr>`;
}

function bankStatus(item) {
  if (item.transactionId) return "conciliado";
  if (item.category) return "classificado";
  return "pendente";
}

function bankStatusBadge(item) {
  const status = bankStatus(item);
  const labels = { pendente: "Pendente", classificado: "Classificado", conciliado: "Conciliado" };
  const css = status === "pendente" ? "aberto" : "baixado";
  return `<span class="status ${css}">${labels[status]}</span>`;
}

function handleBankAction(action, id) {
  const movement = state.bankMovements.find((item) => item.id === id);
  if (!movement) return;

  if (action === "classify") {
    openBankDialog(movement);
    return;
  }

  if (action === "unlink") {
    unlinkBankMovement(movement);
    persist();
    renderAll();
    toast("Conciliação desfeita.");
  }
}

function openBankDialog(movement) {
  els.bankForm.reset();
  els.bankMovementId.value = movement.id;
  els.bankCategory.value = movement.category || suggestCategory(movement);
  els.bankDreGroup.value = movement.dreGroup || (movement.type === "entrada" ? "receita_bruta" : "despesas_operacionais");
  hydrateProjectOptions();
  els.bankProject.value = movement.projectId || "";
  els.bankNotes.value = movement.notes || "";
  els.bankMovementSummary.innerHTML = `
    <strong>${movement.type === "entrada" ? "Entrada" : "Saída"} de ${money(movement.amount)}</strong>
    <span>${formatDate(movement.date)} · ${escapeHtml(movement.description)}</span>`;
  hydrateBankMatches(movement);
  els.bankMatchTransaction.value = movement.transactionId || "";
  els.bankMatchTransaction.onchange = () => {
    if (!els.bankProject.value) {
      const transaction = state.transactions.find((item) => item.id === els.bankMatchTransaction.value);
      const allocations = transaction ? normalizeAllocations(transaction) : [];
      if (allocations.length === 1) els.bankProject.value = allocations[0].projectId;
    }
  };
  els.bankDialog.showModal();
}

function hydrateBankMatches(movement) {
  const expectedType = movement.type === "entrada" ? "receber" : "pagar";
  const matches = state.transactions
    .filter((item) => item.type === expectedType)
    .filter((item) => item.status === "aberto" || item.id === movement.transactionId)
    .map((item) => ({ item, score: matchScore(movement, item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  els.bankMatchTransaction.innerHTML = [
    `<option value="">Somente classificar, sem conciliar</option>`,
    ...matches.map(({ item }) => `<option value="${item.id}">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${escapeHtml(item.description)} · ${escapeHtml(transactionProjectLabel(item))} · ${money(item.amount)}</option>`),
  ].join("");
}

function matchScore(movement, transaction) {
  const amountDiff = Math.abs(movement.amount - transaction.amount);
  if (amountDiff > 0.02) return -1;
  const dayDiff = Math.abs(daysBetween(movement.date, transaction.dueDate));
  if (dayDiff > 15) return 10 - dayDiff;
  return 100 - dayDiff;
}

function saveBankClassification() {
  const movement = state.bankMovements.find((item) => item.id === els.bankMovementId.value);
  if (!movement) return;

  unlinkBankMovement(movement);
  movement.category = els.bankCategory.value.trim();
  movement.dreGroup = els.bankDreGroup.value;
  const matchedTransaction = state.transactions.find((item) => item.id === els.bankMatchTransaction.value);
  const matchedAllocations = matchedTransaction ? normalizeAllocations(matchedTransaction) : [];
  movement.projectId = els.bankProject.value || (matchedAllocations.length === 1 ? matchedAllocations[0].projectId : "");
  movement.notes = els.bankNotes.value.trim();
  movement.transactionId = els.bankMatchTransaction.value;

  if (movement.transactionId) {
    const transaction = matchedTransaction;
    if (transaction) {
      transaction.status = transaction.type === "receber" ? "recebido" : "pago";
      transaction.paidDate = movement.date;
      transaction.category = movement.category || transaction.category;
      transaction.dreGroup = movement.dreGroup || transaction.dreGroup;
      transaction.projectId = movement.projectId || transaction.projectId || "";
      transaction.allocations = movement.projectId
        ? [{ projectId: movement.projectId, amount: transaction.amount }]
        : normalizeAllocations(transaction);
      transaction.directProjectCost = transaction.type === "pagar" && Boolean(movement.projectId);
      transaction.bankMovementId = movement.id;
    }
  }

  persist();
  renderAll();
  els.bankDialog.close();
  toast("Movimento bancário salvo.");
}

function unlinkBankMovement(movement) {
  if (!movement.transactionId) return;
  const transaction = state.transactions.find((item) => item.id === movement.transactionId);
  if (transaction?.bankMovementId === movement.id) {
    transaction.status = "aberto";
    transaction.paidDate = "";
    transaction.bankMovementId = "";
  }
  movement.transactionId = "";
}

function suggestCategory(movement) {
  const text = movement.description.toLowerCase();
  if (text.includes("pix")) return movement.type === "entrada" ? "Recebimentos PIX" : "Pagamentos PIX";
  if (text.includes("tarifa") || text.includes("taxa")) return "Tarifas bancárias";
  if (text.includes("salario") || text.includes("folha")) return "Folha";
  if (text.includes("boleto")) return movement.type === "entrada" ? "Recebimento boleto" : "Pagamento boleto";
  return movement.type === "entrada" ? "Receitas financeiras" : "Despesas bancárias";
}

function exportBankCsv() {
  const rows = filteredBankMovements().map((item) => [
    item.date,
    item.type,
    item.description,
    item.bankId,
    item.accountId,
    item.documentNumber,
    item.category,
    item.projectId ? projectName(item.projectId) : "",
    dreGroupLabel(item.dreGroup),
    bankStatus(item),
    item.amount,
    item.transactionId ? "sim" : "nao",
    item.notes,
  ]);
  downloadCsv(`movimentos-bancarios-${todayIso}.csv`, [["data", "tipo", "historico", "banco", "conta", "documento", "categoria", "projeto", "grupo_dre", "status", "valor", "conciliado", "observacoes"], ...rows]);
}

function renderPeople() {
  const search = document.querySelector("#peopleSearch").value.toLowerCase().trim();
  const people = state.people
    .filter((person) => `${person.name} ${person.document} ${person.contact}`.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));

  document.querySelector("#peopleList").innerHTML = people.length
    ? people.map((person) => `
      <article class="person-item">
        <strong><span>${escapeHtml(person.name)}</span><span>${personTypeLabel(person.type)}</span></strong>
        <span class="muted">${escapeHtml(person.document || "Sem documento")} · ${escapeHtml(person.contact || "Sem contato")}</span>
        <div class="row-actions">
          <button type="button" data-person-action="edit" data-id="${person.id}">Editar</button>
          <button type="button" data-person-action="delete" data-id="${person.id}">Excluir</button>
        </div>
      </article>`).join("")
    : emptyMessage("Nenhum cadastro encontrado.");

  document.querySelectorAll("[data-person-action]").forEach((button) => {
    button.addEventListener("click", () => handlePersonAction(button.dataset.personAction, button.dataset.id));
  });
}

function savePerson() {
  const data = {
    id: els.personId.value || crypto.randomUUID(),
    type: els.personType.value,
    name: els.personName.value.trim(),
    document: els.personDocument.value.trim(),
    contact: els.personContact.value.trim(),
  };

  const index = state.people.findIndex((person) => person.id === data.id);
  if (index >= 0) state.people[index] = data;
  else state.people.push(data);

  els.personForm.reset();
  els.personId.value = "";
  persist();
  renderAll();
  toast("Cadastro salvo.");
}

function handlePersonAction(action, id) {
  const person = state.people.find((item) => item.id === id);
  if (!person) return;

  if (action === "edit") {
    els.personId.value = person.id;
    els.personType.value = person.type;
    els.personName.value = person.name;
    els.personDocument.value = person.document;
    els.personContact.value = person.contact;
    return;
  }

  const inUse = state.transactions.some((item) => item.personId === id) || state.sales.some((sale) => sale.personId === id);
  if (inUse) {
    toast("Não é possível excluir: há lançamentos vinculados.");
    return;
  }

  state.people = state.people.filter((item) => item.id !== id);
  persist();
  renderAll();
  toast("Cadastro excluído.");
}

function openTransactionDialog(item = null) {
  els.transactionForm.reset();
  els.transactionId.value = item?.id || "";
  els.transactionType.value = item?.type || "receber";
  hydratePersonOptions();
  hydrateProjectOptions();
  hydrateStatusOptions();
  els.transactionPerson.value = item?.personId || els.transactionPerson.value;
  els.transactionDescription.value = item?.description || "";
  els.transactionCategory.value = item?.category || "";
  els.transactionDreGroup.value = item?.dreGroup || defaultDreGroup(els.transactionType.value);
  els.transactionDueDate.value = item?.dueDate || todayIso;
  els.transactionAmount.value = item?.amount || "";
  els.transactionStatus.value = item?.status || "aberto";
  els.transactionPaidDate.value = item?.paidDate || "";
  els.transactionDirectProjectCost.checked = Boolean(item?.directProjectCost);
  const allocations = item?.allocations || [];
  els.transactionProjectMode.value = allocations.length > 1 ? "split" : allocations.length === 1 ? "single" : "none";
  els.transactionProject.value = allocations[0]?.projectId || "";
  renderAllocationControls();
  renderAllocationRows(allocations);
  els.transactionNotes.value = item?.notes || "";
  els.transactionTitle.textContent = item ? "Editar lançamento" : "Novo lançamento";
  els.transactionDialog.showModal();
}

function saveTransaction() {
  const type = els.transactionType.value;
  const status = els.transactionStatus.value;
  const existing = state.transactions.find((item) => item.id === els.transactionId.value);
  const allocations = getTransactionAllocations();
  if (!validateAllocations(Number(els.transactionAmount.value), allocations)) {
    toast("A soma do rateio precisa ser igual ao valor total do lançamento.");
    return;
  }
  const data = {
    id: els.transactionId.value || crypto.randomUUID(),
    type,
    personId: els.transactionPerson.value,
    description: els.transactionDescription.value.trim(),
    category: els.transactionCategory.value.trim(),
    dreGroup: els.transactionDreGroup.value,
    dueDate: els.transactionDueDate.value,
    amount: Number(els.transactionAmount.value),
    status,
    paidDate: ["recebido", "pago"].includes(status) ? (els.transactionPaidDate.value || todayIso) : "",
    notes: els.transactionNotes.value.trim(),
    directProjectCost: els.transactionDirectProjectCost.checked,
    projectId: allocations.length === 1 ? allocations[0].projectId : "",
    allocations,
    saleId: existing?.saleId || "",
    installmentNumber: existing?.installmentNumber || "",
    installmentTotal: existing?.installmentTotal || "",
    bankMovementId: existing?.bankMovementId || "",
    updatedAt: new Date().toISOString(),
  };

  const index = state.transactions.findIndex((item) => item.id === data.id);
  if (index >= 0) state.transactions[index] = data;
  else state.transactions.push(data);

  persist();
  renderAll();
  els.transactionDialog.close();
  toast("Lançamento salvo.");
}

function hydratePersonOptions() {
  const type = els.transactionType.value;
  const people = state.people.filter((person) => person.type === "ambos" || (type === "receber" ? person.type === "cliente" : person.type === "fornecedor"));
  els.transactionPerson.innerHTML = people.length
    ? people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">Cadastre ${type === "receber" ? "um cliente" : "um fornecedor"} primeiro</option>`;
}

function hydrateSalePeople() {
  const people = state.people.filter((person) => person.type === "cliente" || person.type === "ambos");
  els.salePerson.innerHTML = people.length
    ? people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">Cadastre um cliente primeiro</option>`;
}

function hydrateStatusOptions() {
  const type = els.transactionType.value;
  const paid = type === "receber" ? "recebido" : "pago";
  els.transactionStatus.innerHTML = `
    <option value="aberto">Em aberto</option>
    <option value="${paid}">${statusLabel(paid)}</option>
  `;
}

function setDefaultDreGroup() {
  els.transactionDreGroup.value = defaultDreGroup(els.transactionType.value);
}

function renderAllocationControls() {
  const mode = els.transactionProjectMode.value;
  els.transactionProjectWrap.classList.toggle("hidden", mode !== "single");
  els.allocationBox.classList.toggle("hidden", mode !== "split");
  els.transactionDirectProjectCost.parentElement.classList.toggle("hidden", mode === "none");
  if (mode === "split" && !els.allocationRows.children.length) {
    addAllocationRow();
  }
  renderAllocationTotal();
}

function renderAllocationRows(allocations = []) {
  els.allocationRows.innerHTML = "";
  allocations.forEach((allocation) => addAllocationRow(allocation));
  if (els.transactionProjectMode.value === "split" && !allocations.length) {
    addAllocationRow();
  }
  renderAllocationTotal();
}

function addAllocationRow(allocation = {}) {
  const row = document.createElement("div");
  row.className = "allocation-row";
  row.innerHTML = `
    <select data-allocation-project>
      ${state.projects.map((project) => `<option value="${project.id}">${escapeHtml(projectLabel(project))}</option>`).join("")}
    </select>
    <input data-allocation-amount type="number" min="0.01" step="0.01" placeholder="Valor" />
    <button class="secondary-btn" data-remove-allocation type="button">Remover</button>
  `;
  els.allocationRows.appendChild(row);
  row.querySelector("[data-allocation-project]").value = allocation.projectId || state.projects[0]?.id || "";
  row.querySelector("[data-allocation-amount]").value = allocation.amount || "";
  row.querySelector("[data-allocation-amount]").addEventListener("input", renderAllocationTotal);
  row.querySelector("[data-remove-allocation]").addEventListener("click", () => {
    row.remove();
    renderAllocationTotal();
  });
  renderAllocationTotal();
}

function getTransactionAllocations() {
  const amount = roundCurrency(Number(els.transactionAmount.value || 0));
  if (els.transactionProjectMode.value === "none") return [];
  if (els.transactionProjectMode.value === "single") {
    return els.transactionProject.value ? [{ projectId: els.transactionProject.value, amount }] : [];
  }

  return [...els.allocationRows.querySelectorAll(".allocation-row")]
    .map((row) => ({
      projectId: row.querySelector("[data-allocation-project]").value,
      amount: roundCurrency(Number(row.querySelector("[data-allocation-amount]").value || 0)),
    }))
    .filter((allocation) => allocation.projectId && allocation.amount > 0);
}

function renderAllocationTotal() {
  const allocations = getTransactionAllocations();
  const total = allocationTotal(allocations);
  const amount = roundCurrency(Number(els.transactionAmount.value || 0));
  const diff = roundCurrency(amount - total);
  els.allocationTotal.textContent = `Total rateado: ${money(total)} · Diferença: ${money(diff)}`;
  els.allocationTotal.classList.toggle("invalid", allocations.length > 0 && Math.abs(diff) >= 0.01);
}

function renderReports() {
  const period = getReportPeriod();
  const periodTransactions = state.transactions.filter((item) => isInPeriod(item.dueDate, period.start, period.end));
  const receberPeriod = periodTransactions.filter((item) => item.type === "receber");
  const pagarPeriod = periodTransactions.filter((item) => item.type === "pagar");
  const bankOnly = els.dreBasis.value === "caixa"
    ? state.bankMovements.filter((item) => item.category && !item.transactionId && isInPeriod(item.date, period.start, period.end))
    : [];
  const receitas = sum(receberPeriod) + sum(bankOnly.filter((item) => item.type === "entrada"));
  const despesas = sum(pagarPeriod) + sum(bankOnly.filter((item) => item.type === "saida"));
  const dre = calculateDre();

  document.querySelector("#reportReceitas").textContent = money(receitas);
  document.querySelector("#reportDespesas").textContent = money(despesas);
  document.querySelector("#dreResultado").textContent = money(dre.result);
  document.querySelector("#dreMargem").textContent = receitas ? `${((dre.result / receitas) * 100).toFixed(1)}%` : "0,0%";

  renderDreReport(dre);
  renderPeriodReport("receberPeriodReport", receberPeriod);
  renderPeriodReport("pagarPeriodReport", pagarPeriod);
  renderCategoryReport(periodTransactions);
  renderOverdueReport();
}

function renderDreReport(dre) {
  const rows = dreGroups.map((group) => ({ ...group, total: dre.groups[group.key] || 0 }));
  document.querySelector("#dreReport").innerHTML = `
    ${rows.map((row) => `
      <article class="dre-row">
        <span>${row.label}</span>
        <strong>${money(row.total)}</strong>
      </article>`).join("")}
    <article class="dre-row dre-total">
      <span>Resultado líquido</span>
      <strong>${money(dre.result)}</strong>
    </article>`;
}

function renderPeriodReport(targetId, rows) {
  document.querySelector(`#${targetId}`).innerHTML = rows.length
    ? rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${statusLabel(item.status)}</span>
      </article>`).join("")
    : emptyMessage("Nenhum lançamento no período.");
}

function renderCategoryReport(periodTransactions) {
  const type = document.querySelector("#categoryReportType").value;
  const byCategory = groupByCategory(periodTransactions.filter((item) => item.type === type));
  document.querySelector("#categoryReport").innerHTML = byCategory.length
    ? byCategory.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.category)}</span><span>${money(row.total)}</span></strong>
        <span class="muted">${row.count} lançamento(s)</span>
      </article>`).join("")
    : emptyMessage("Sem dados para este relatório.");
}

function renderOverdueReport() {
  const overdue = state.transactions.filter(isOverdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  document.querySelector("#overdueReport").innerHTML = overdue.length
    ? overdue.map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${item.type === "receber" ? "A receber" : "A pagar"}</span>
      </article>`).join("")
    : emptyMessage("Nenhum lançamento vencido em aberto.");
}

function calculateDre() {
  const period = getReportPeriod();
  const basis = els.dreBasis.value;
  const rows = state.transactions.filter((item) => {
    const date = basis === "caixa" ? item.paidDate : item.dueDate;
    if (basis === "caixa" && !["recebido", "pago"].includes(item.status)) return false;
    return isInPeriod(date, period.start, period.end);
  });

  const groups = Object.fromEntries(dreGroups.map((group) => [group.key, 0]));
  rows.forEach((item) => {
    const key = item.dreGroup || defaultDreGroup(item.type);
    const group = dreGroups.find((entry) => entry.key === key) || dreGroups.at(-1);
    groups[group.key] += item.type === "receber" ? item.amount * group.sign : -item.amount;
  });

  if (basis === "caixa") {
    state.bankMovements
      .filter((item) => item.category && !item.transactionId && isInPeriod(item.date, period.start, period.end))
      .forEach((item) => {
        const group = dreGroups.find((entry) => entry.key === item.dreGroup) || dreGroups.at(-1);
        groups[group.key] += item.type === "entrada" ? item.amount * group.sign : -item.amount;
      });
  }

  return {
    groups,
    result: Object.values(groups).reduce((total, value) => total + value, 0),
  };
}

function groupByCategory(items) {
  const map = new Map();
  items.forEach((item) => {
    const row = map.get(item.category) || { category: item.category, total: 0, count: 0 };
    row.total += item.amount;
    row.count += 1;
    map.set(item.category, row);
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function exportBackup() {
  download(`financeiro-lumeris-backup-${todayIso}.json`, JSON.stringify(state, null, 2), "application/json");
}

function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = normalizeState(JSON.parse(reader.result));
    } catch {
      toast("Arquivo inválido.");
      return;
    }

    state.people = data.people;
    state.sales = data.sales;
    state.projects = data.projects;
    state.costCenters = data.costCenters;
    state.bankAccounts = data.bankAccounts;
    state.bankMovements = data.bankMovements;
    state.transactions = data.transactions;
    persist();
    renderAll();
    toast("Backup importado.");
  };
  reader.readAsText(file);
  event.target.value = "";
}

function exportCsv(type) {
  const header = ["tipo", "pessoa", "descricao", "parcela", "categoria", "grupo_dre", "vencimento", "valor", "status", "baixa", "observacoes"];
  const rows = state.transactions
    .filter((item) => item.type === type)
    .map((item) => [item.type, personName(item.personId), item.description, installmentLabel(item), item.category, dreGroupLabel(item.dreGroup), item.dueDate, item.amount, item.status, item.paidDate, item.notes]);
  downloadCsv(`financeiro-lumeris-${type}-${todayIso}.csv`, [header, ...rows]);
}

function exportReport(report) {
  const period = getReportPeriod();
  if (report === "dre") {
    const dre = calculateDre();
    const rows = [["grupo", "valor"], ...dreGroups.map((group) => [group.label, dre.groups[group.key] || 0]), ["Resultado líquido", dre.result]];
    downloadCsv(`dre-${period.start}-${period.end}.csv`, rows);
    return;
  }

  const type = report === "receber-periodo" ? "receber" : "pagar";
  const rows = state.transactions
    .filter((item) => item.type === type && isInPeriod(item.dueDate, period.start, period.end))
    .map((item) => [personName(item.personId), item.description, item.category, dreGroupLabel(item.dreGroup), item.dueDate, item.amount, item.status, item.paidDate]);
  downloadCsv(`${type}-periodo-${period.start}-${period.end}.csv`, [["pessoa", "descricao", "categoria", "grupo_dre", "data", "valor", "status", "baixa"], ...rows]);
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvCell).join(";")).join("\n");
  download(filename, csv, "text/csv;charset=utf-8");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getReportPeriod() {
  return {
    start: els.reportStart.value || "0000-01-01",
    end: els.reportEnd.value || "9999-12-31",
  };
}

function reportDate(item) {
  return els.dreBasis.value === "caixa" && item.paidDate ? item.paidDate : item.dueDate;
}

function isInPeriod(date, start, end) {
  return Boolean(date) && date >= start && date <= end;
}

function personName(id) {
  return state.people.find((person) => person.id === id)?.name || "Sem cadastro";
}

function personTypeLabel(type) {
  return { cliente: "Cliente", fornecedor: "Fornecedor", ambos: "Ambos" }[type] || type;
}

function statusLabel(status) {
  return { aberto: "Em aberto", recebido: "Recebido", pago: "Pago" }[status] || status;
}

function installmentLabel(item) {
  return item.installmentNumber ? `${item.installmentNumber}/${item.installmentTotal}` : "-";
}

function defaultDreGroup(type) {
  return type === "receber" ? "receita_bruta" : "despesas_operacionais";
}

function dreGroupLabel(key) {
  return dreGroups.find((group) => group.key === key)?.label || "Outros";
}

function isOverdue(item) {
  return item.status === "aberto" && item.dueDate < todayIso;
}

function isPaidThisMonth(item) {
  return ["recebido", "pago"].includes(item.status) && item.paidDate && monthKey(parseDate(item.paidDate)) === monthKey(today);
}

function signedAmount(item) {
  return item.type === "receber" ? item.amount : -item.amount;
}

function sum(items) {
  return items.reduce((total, item) => total + (typeof item === "number" ? item : item.amount), 0);
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function formatDate(iso) {
  if (!iso) return "-";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function toIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(iso) {
  return new Date(`${iso}T00:00:00`);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function daysBetween(firstIso, secondIso) {
  const ms = parseDate(firstIso).getTime() - parseDate(secondIso).getTime();
  return Math.round(ms / 86400000);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function emptyMessage(text) {
  return `<span class="muted">${text}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}
