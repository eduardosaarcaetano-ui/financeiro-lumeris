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

const SEARCH_ICON_SVG = '<svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>';

let currentInvoiceKind = "servico";

const INVOICE_STATUS_OPTIONS_EMITIDA = [
  { value: "emitida", label: "Emitida" },
  { value: "recebida_parcial", label: "Recebida parcialmente" },
  { value: "recebida_total", label: "Recebida totalmente" },
  { value: "cancelada", label: "Cancelada" },
];

const INVOICE_STATUS_OPTIONS_DESPESA = [
  { value: "aberto", label: "Em aberto" },
  { value: "paga", label: "Paga" },
  { value: "conciliada", label: "Conciliada" },
  { value: "cancelada", label: "Cancelada" },
];

// Um único menu "Notas Fiscais" com 3 sub-abas (kind), em vez de 3 telas separadas —
// evita triplicar formulário/lista/relatórios para dados que têm a mesma forma.
const INVOICE_KIND_META = {
  servico: { label: "NF de Serviço emitida", direction: "emitida", personLabel: "Cliente", statusOptions: INVOICE_STATUS_OPTIONS_EMITIDA },
  material: { label: "NF de Material/Produto emitida", direction: "emitida", personLabel: "Cliente", statusOptions: INVOICE_STATUS_OPTIONS_EMITIDA },
  despesa: { label: "NF de despesa recebida", direction: "recebida", personLabel: "Fornecedor", statusOptions: INVOICE_STATUS_OPTIONS_DESPESA },
};

// Camada de integração bancária: cada provedor implementa fetchStatement(account, {start, end})
// e devolve movimentos no MESMO formato produzido por parseOfx, para reaproveitar dedupe/conciliação.
// "inter" e "santander" nunca chamam o banco direto do navegador (impossível: exigem mTLS/segredos que
// não podem existir num site estático) — eles chamam um backend próprio que você hospeda e que guarda
// as credenciais reais. Enquanto esse backend não existir, use o provedor "mock".
// (Referencia funções declaradas mais abaixo — seguro porque function declarations são hoisted.)
const BANK_PROVIDERS = {
  mock: { label: "Simulado (dados de teste)", requiresEndpoint: false, fetchStatement: (account, range) => mockFetchStatement(account, range) },
  inter: { label: "Banco Inter (API real via backend)", requiresEndpoint: true, fetchStatement: (account, range) => fetchStatementViaBackend("inter", account, range) },
  santander: { label: "Santander (API real via backend)", requiresEndpoint: true, fetchStatement: (account, range) => fetchStatementViaBackend("santander", account, range) },
};

const MOCK_DESCRIPTIONS = {
  "077": {
    entrada: ["Pix recebido - Cliente Simulado", "Transferência recebida", "Rendimento de aplicação"],
    saida: ["Pix enviado - Fornecedor Simulado", "Pagamento de boleto", "Tarifa de manutenção"],
  },
  "033": {
    entrada: ["TED recebida", "Depósito identificado", "Rendimento CDB"],
    saida: ["Débito automático", "Compra no débito", "Pagamento de convênio"],
  },
};

// Controle de acesso por papel. "administrador" (null) enxerga tudo; os demais papéis
// só acessam as views listadas aqui. Este é o único lugar que decide isso — setView() e
// updateSessionUi() (menu) consultam a mesma função canAccessView(), então não existe
// como uma tela ficar acessível por engano num lugar e bloqueada em outro.
const ROLE_ALLOWED_VIEWS = {
  administrador: null,
  usuario: ["dashboard", "receber", "pagar", "vendas", "projetos", "homologacao", "instalacoes", "banco", "notasfiscais", "pessoas", "relatorios", "estoque", "crm"],
  estoque: ["estoque"],
};

const ROLE_LABELS = {
  administrador: "Administrador",
  estoque: "Estoque",
  usuario: "Usuário",
};

let currentStockTab = "itens";

const STOCK_UNIT_LABELS = {
  unidade: "Unidade",
  peca: "Peça",
  metro: "Metro",
  metro_quadrado: "Metro quadrado",
  metro_cubico: "Metro cúbico",
  quilo: "Quilo",
  litro: "Litro",
  caixa: "Caixa",
  pacote: "Pacote",
  rolo: "Rolo",
};

const STOCK_EXIT_TYPE_LABELS = {
  consumo_projeto: "Consumo em projeto",
  uso_interno: "Uso interno",
  transferencia: "Transferência",
  perda: "Perda",
  avaria: "Avaria",
  descarte: "Descarte",
  emprestimo: "Empréstimo",
  outro: "Outro",
};

let currentCrmTab = "funil";
let pendingOpportunityConversion = null;
let pendingWonOpportunity = null;

// Ordem do funil — usada tanto para renderizar as colunas quanto para calcular
// taxa de conversão por estágio nos relatórios. "ganho"/"perdido" são estágios
// terminais (não têm "próximo estágio" para fins de conversão sequencial).
const OPPORTUNITY_STAGES = [
  { key: "prospeccao", label: "Prospecção" },
  { key: "contato", label: "Contato" },
  { key: "proposta", label: "Proposta" },
  { key: "negociacao", label: "Negociação" },
  { key: "ganho", label: "Ganho" },
  { key: "perdido", label: "Perdido" },
];

const INTERACTION_TYPE_LABELS = {
  ligacao: "Ligação",
  email: "E-mail",
  reuniao: "Reunião",
  whatsapp: "WhatsApp",
  outro: "Outro",
};

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
  invoiceForm: document.querySelector("#invoiceForm"),
  invoiceFormTitle: document.querySelector("#invoiceFormTitle"),
  invoiceId: document.querySelector("#invoiceId"),
  invoiceKind: document.querySelector("#invoiceKind"),
  invoiceNumber: document.querySelector("#invoiceNumber"),
  invoiceSeries: document.querySelector("#invoiceSeries"),
  invoicePersonWrap: document.querySelector("#invoicePersonWrap"),
  invoicePersonLabel: document.querySelector("#invoicePersonLabel"),
  invoicePerson: document.querySelector("#invoicePerson"),
  invoiceDocument: document.querySelector("#invoiceDocument"),
  invoiceIssueDate: document.querySelector("#invoiceIssueDate"),
  invoiceCompetenceWrap: document.querySelector("#invoiceCompetenceWrap"),
  invoiceCompetenceDate: document.querySelector("#invoiceCompetenceDate"),
  invoiceDueDateWrap: document.querySelector("#invoiceDueDateWrap"),
  invoiceDueDate: document.querySelector("#invoiceDueDate"),
  invoiceProject: document.querySelector("#invoiceProject"),
  invoiceCategory: document.querySelector("#invoiceCategory"),
  invoiceGrossAmount: document.querySelector("#invoiceGrossAmount"),
  invoiceTaxAmount: document.querySelector("#invoiceTaxAmount"),
  invoiceAccountingValue: document.querySelector("#invoiceAccountingValue"),
  invoiceStatus: document.querySelector("#invoiceStatus"),
  invoiceDescription: document.querySelector("#invoiceDescription"),
  invoiceNotes: document.querySelector("#invoiceNotes"),
  invoiceSearch: document.querySelector("#invoiceSearch"),
  invoiceList: document.querySelector("#invoiceList"),
  invoiceLinkDialog: document.querySelector("#invoiceLinkDialog"),
  invoiceLinkForm: document.querySelector("#invoiceLinkForm"),
  invoiceLinkId: document.querySelector("#invoiceLinkId"),
  invoiceLinkTitle: document.querySelector("#invoiceLinkTitle"),
  invoiceLinkSummary: document.querySelector("#invoiceLinkSummary"),
  invoiceLinkList: document.querySelector("#invoiceLinkList"),
  bankMatchInvoice: document.querySelector("#bankMatchInvoice"),
  stockAlertBelowMin: document.querySelector("#stockAlertBelowMin"),
  stockAlertZero: document.querySelector("#stockAlertZero"),
  stockAlertAboveMax: document.querySelector("#stockAlertAboveMax"),
  stockItemForm: document.querySelector("#stockItemForm"),
  stockItemFormTitle: document.querySelector("#stockItemFormTitle"),
  stockItemId: document.querySelector("#stockItemId"),
  stockInternalCode: document.querySelector("#stockInternalCode"),
  stockBarcode: document.querySelector("#stockBarcode"),
  stockName: document.querySelector("#stockName"),
  stockDescription: document.querySelector("#stockDescription"),
  stockCategory: document.querySelector("#stockCategory"),
  stockSubcategory: document.querySelector("#stockSubcategory"),
  stockBrand: document.querySelector("#stockBrand"),
  stockModel: document.querySelector("#stockModel"),
  stockUnit: document.querySelector("#stockUnit"),
  stockSupplier: document.querySelector("#stockSupplier"),
  stockLocation: document.querySelector("#stockLocation"),
  stockMinQuantity: document.querySelector("#stockMinQuantity"),
  stockMaxQuantity: document.querySelector("#stockMaxQuantity"),
  stockActive: document.querySelector("#stockActive"),
  stockNotes: document.querySelector("#stockNotes"),
  stockItemSearch: document.querySelector("#stockItemSearch"),
  stockItemTable: document.querySelector("#stockItemTable"),
  stockEntryForm: document.querySelector("#stockEntryForm"),
  stockEntryDate: document.querySelector("#stockEntryDate"),
  stockEntrySupplier: document.querySelector("#stockEntrySupplier"),
  stockEntryItem: document.querySelector("#stockEntryItem"),
  stockEntryQuantity: document.querySelector("#stockEntryQuantity"),
  stockEntryUnitCost: document.querySelector("#stockEntryUnitCost"),
  stockEntryTotalCost: document.querySelector("#stockEntryTotalCost"),
  stockEntryInvoiceNumber: document.querySelector("#stockEntryInvoiceNumber"),
  stockEntryInvoice: document.querySelector("#stockEntryInvoice"),
  stockEntryTransaction: document.querySelector("#stockEntryTransaction"),
  stockEntryProject: document.querySelector("#stockEntryProject"),
  stockEntryNotes: document.querySelector("#stockEntryNotes"),
  stockEntryList: document.querySelector("#stockEntryList"),
  stockExitForm: document.querySelector("#stockExitForm"),
  stockExitDate: document.querySelector("#stockExitDate"),
  stockExitItem: document.querySelector("#stockExitItem"),
  stockExitQuantity: document.querySelector("#stockExitQuantity"),
  stockExitType: document.querySelector("#stockExitType"),
  stockExitProjectWrap: document.querySelector("#stockExitProjectWrap"),
  stockExitProject: document.querySelector("#stockExitProject"),
  stockExitRecipient: document.querySelector("#stockExitRecipient"),
  stockExitReason: document.querySelector("#stockExitReason"),
  stockExitNotes: document.querySelector("#stockExitNotes"),
  stockExitList: document.querySelector("#stockExitList"),
  stockPurchaseNeedTable: document.querySelector("#stockPurchaseNeedTable"),
  pipelineBoard: document.querySelector("#pipelineBoard"),
  opportunityDialog: document.querySelector("#opportunityDialog"),
  opportunityForm: document.querySelector("#opportunityForm"),
  opportunityFormTitle: document.querySelector("#opportunityFormTitle"),
  opportunityId: document.querySelector("#opportunityId"),
  opportunityTitle: document.querySelector("#opportunityTitle"),
  opportunityPersonName: document.querySelector("#opportunityPersonName"),
  opportunityPersonSuggestions: document.querySelector("#opportunityPersonSuggestions"),
  opportunityValue: document.querySelector("#opportunityValue"),
  opportunityProbability: document.querySelector("#opportunityProbability"),
  opportunityExpectedCloseDate: document.querySelector("#opportunityExpectedCloseDate"),
  opportunitySeller: document.querySelector("#opportunitySeller"),
  opportunityStage: document.querySelector("#opportunityStage"),
  interactionDialog: document.querySelector("#interactionDialog"),
  interactionForm: document.querySelector("#interactionForm"),
  interactionOpportunityId: document.querySelector("#interactionOpportunityId"),
  interactionType: document.querySelector("#interactionType"),
  interactionDate: document.querySelector("#interactionDate"),
  interactionNotes: document.querySelector("#interactionNotes"),
  interactionNextFollowUpDate: document.querySelector("#interactionNextFollowUpDate"),
  taskDialog: document.querySelector("#taskDialog"),
  taskForm: document.querySelector("#taskForm"),
  taskId: document.querySelector("#taskId"),
  taskTitle: document.querySelector("#taskTitle"),
  taskDescription: document.querySelector("#taskDescription"),
  taskDueDate: document.querySelector("#taskDueDate"),
  taskSeller: document.querySelector("#taskSeller"),
  taskOpportunity: document.querySelector("#taskOpportunity"),
  taskPerson: document.querySelector("#taskPerson"),
  opportunityLostDialog: document.querySelector("#opportunityLostDialog"),
  opportunityLostForm: document.querySelector("#opportunityLostForm"),
  opportunityLostId: document.querySelector("#opportunityLostId"),
  opportunityLostReason: document.querySelector("#opportunityLostReason"),
  opportunityWonDialog: document.querySelector("#opportunityWonDialog"),
  opportunityWonForm: document.querySelector("#opportunityWonForm"),
  opportunityWonSummary: document.querySelector("#opportunityWonSummary"),
  sellerDialog: document.querySelector("#sellerDialog"),
  sellerForm: document.querySelector("#sellerForm"),
  sellerName: document.querySelector("#sellerName"),
  sellerList: document.querySelector("#sellerList"),
  followUpList: document.querySelector("#followUpList"),
  taskSellerFilter: document.querySelector("#taskSellerFilter"),
  taskStatusFilter: document.querySelector("#taskStatusFilter"),
  tasksOverdueList: document.querySelector("#tasksOverdueList"),
  tasksTodayList: document.querySelector("#tasksTodayList"),
  tasksWeekList: document.querySelector("#tasksWeekList"),
  tasksLaterList: document.querySelector("#tasksLaterList"),
  crmReportPeriod: document.querySelector("#crmReportPeriod"),
  crmReportStartWrap: document.querySelector("#crmReportStartWrap"),
  crmReportStart: document.querySelector("#crmReportStart"),
  crmReportEndWrap: document.querySelector("#crmReportEndWrap"),
  crmReportEnd: document.querySelector("#crmReportEnd"),
  crmAvgTicket: document.querySelector("#crmAvgTicket"),
  crmAvgCloseTime: document.querySelector("#crmAvgCloseTime"),
  crmWonCount: document.querySelector("#crmWonCount"),
  crmLostCount: document.querySelector("#crmLostCount"),
  crmStageConversionReport: document.querySelector("#crmStageConversionReport"),
  crmSellerRankingTable: document.querySelector("#crmSellerRankingTable"),
  navItems: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  crmUnitFilter: document.querySelector("#crmUnitFilter"),
  crmPipelineFilter: document.querySelector("#crmPipelineFilter"),
  crmOwnerFilter: document.querySelector("#crmOwnerFilter"),
  crmStageFilter: document.querySelector("#crmStageFilter"),
  crmProjectFilter: document.querySelector("#crmProjectFilter"),
  crmSearch: document.querySelector("#crmSearch"),
  crmMinValue: document.querySelector("#crmMinValue"),
  crmMaxValue: document.querySelector("#crmMaxValue"),
  crmPendingOnly: document.querySelector("#crmPendingOnly"),
  crmStaleOnly: document.querySelector("#crmStaleOnly"),
  kanbanBoard: document.querySelector("#kanbanBoard"),
  opportunityDialog: document.querySelector("#opportunityDialog"),
  opportunityForm: document.querySelector("#opportunityForm"),
  opportunityTitle: document.querySelector("#opportunityTitle"),
  opportunityId: document.querySelector("#opportunityId"),
  opportunityPerson: document.querySelector("#opportunityPerson"),
  opportunityCompany: document.querySelector("#opportunityCompany"),
  opportunityNumber: document.querySelector("#opportunityNumber"),
  opportunityValue: document.querySelector("#opportunityValue"),
  opportunityUnit: document.querySelector("#opportunityUnit"),
  opportunityPipeline: document.querySelector("#opportunityPipeline"),
  opportunityStage: document.querySelector("#opportunityStage"),
  opportunityOwner: document.querySelector("#opportunityOwner"),
  opportunityPhone: document.querySelector("#opportunityPhone"),
  opportunityEmail: document.querySelector("#opportunityEmail"),
  opportunityProject: document.querySelector("#opportunityProject"),
  opportunityTags: document.querySelector("#opportunityTags"),
  opportunityNextActivity: document.querySelector("#opportunityNextActivity"),
  opportunityPendingActivity: document.querySelector("#opportunityPendingActivity"),
  opportunityNotes: document.querySelector("#opportunityNotes"),
  opportunityHistory: document.querySelector("#opportunityHistory"),
  transactionDialog: document.querySelector("#transactionDialog"),
  transactionForm: document.querySelector("#transactionForm"),
  transactionTitle: document.querySelector("#transactionTitle"),
  transactionId: document.querySelector("#transactionId"),
  transactionType: document.querySelector("#transactionType"),
  transactionPerson: document.querySelector("#transactionPerson"),
  newTransactionPersonBtn: document.querySelector("#newTransactionPersonBtn"),
  transactionDescription: document.querySelector("#transactionDescription"),
  transactionCategory: document.querySelector("#transactionCategory"),
  transactionDreGroup: document.querySelector("#transactionDreGroup"),
  transactionDueDate: document.querySelector("#transactionDueDate"),
  transactionAmount: document.querySelector("#transactionAmount"),
  transactionStatus: document.querySelector("#transactionStatus"),
  transactionPaidDate: document.querySelector("#transactionPaidDate"),
  transactionProjectMode: document.querySelector("#transactionProjectMode"),
  transactionProject: document.querySelector("#transactionProject"),
  newTransactionProjectBtn: document.querySelector("#newTransactionProjectBtn"),
  transactionProjectWrap: document.querySelector("#transactionProjectWrap"),
  transactionDirectProjectCost: document.querySelector("#transactionDirectProjectCost"),
  allocationBox: document.querySelector("#allocationBox"),
  allocationRows: document.querySelector("#allocationRows"),
  allocationTotal: document.querySelector("#allocationTotal"),
  transactionInstallmentBox: document.querySelector("#transactionInstallmentBox"),
  transactionUseInstallments: document.querySelector("#transactionUseInstallments"),
  transactionInstallments: document.querySelector("#transactionInstallments"),
  transactionInstallmentInterval: document.querySelector("#transactionInstallmentInterval"),
  transactionCustomDaysWrap: document.querySelector("#transactionCustomDaysWrap"),
  transactionCustomDays: document.querySelector("#transactionCustomDays"),
  transactionInstallmentPreview: document.querySelector("#transactionInstallmentPreview"),
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
  newBankProjectBtn: document.querySelector("#newBankProjectBtn"),
  bankMatchTransaction: document.querySelector("#bankMatchTransaction"),
  bankNotes: document.querySelector("#bankNotes"),
  bankBalanceList: document.querySelector("#bankBalanceList"),
  bankSyncList: document.querySelector("#bankSyncList"),
  bankSyncDialog: document.querySelector("#bankSyncDialog"),
  bankSyncForm: document.querySelector("#bankSyncForm"),
  bankSyncTitle: document.querySelector("#bankSyncTitle"),
  bankSyncAccountKey: document.querySelector("#bankSyncAccountKey"),
  bankSyncProvider: document.querySelector("#bankSyncProvider"),
  bankSyncStart: document.querySelector("#bankSyncStart"),
  bankSyncEnd: document.querySelector("#bankSyncEnd"),
  bankSyncEndpointWrap: document.querySelector("#bankSyncEndpointWrap"),
  bankSyncEndpoint: document.querySelector("#bankSyncEndpoint"),
  bankSyncHint: document.querySelector("#bankSyncHint"),
  bankSyncSubmit: document.querySelector("#bankSyncSubmit"),
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
  homologationTable: document.querySelector("#homologationTable"),
  installationForm: document.querySelector("#installationForm"),
  installationId: document.querySelector("#installationId"),
  installationProject: document.querySelector("#installationProject"),
  installationCustomer: document.querySelector("#installationCustomer"),
  installationStatus: document.querySelector("#installationStatus"),
  installationScheduledDate: document.querySelector("#installationScheduledDate"),
  installationTeam: document.querySelector("#installationTeam"),
  installationMaterials: document.querySelector("#installationMaterials"),
  installationNotes: document.querySelector("#installationNotes"),
  installationConclusion: document.querySelector("#installationConclusion"),
  installationSearch: document.querySelector("#installationSearch"),
  installationList: document.querySelector("#installationList"),
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
  dashboard: "Dashboard",
  crm: "Pipeline comercial",
  receber: "Contas a receber",
  pagar: "Contas a pagar",
  vendas: "Vendas parceladas",
  projetos: "Projetos e centros de custo",
  homologacao: "Homologação",
  instalacoes: "Instalações",
  banco: "Conciliação bancária",
  notasfiscais: "Notas Fiscais",
  estoque: "Estoque",
  crm: "CRM",
  pessoas: "Clientes e fornecedores",
  relatorios: "Relatórios financeiros",
  usuarios: "Usuários",
};

function getDefaultCrmStages() {
  return [
  { id: "triagem", name: "Triagem", color: "#3f6f8f", order: 1 },
  { id: "contato", name: "Destinados / Contato Inicial", color: "#5d7f3f", order: 2 },
  { id: "diagnostico", name: "Diagnóstico", color: "#a06418", order: 3 },
  { id: "proposta", name: "Proposta", color: "#146c5f", order: 4 },
  { id: "negociacao", name: "Negociação", color: "#8757a2", order: 5 },
  { id: "ganho", name: "Fechado - Ganho", color: "#25744f", order: 6 },
  { id: "perdido", name: "Fechado - Perdido", color: "#aa2f2f", order: 7 },
  ];
}

const dreGroups = [
  { key: "receita_bruta", label: "Receita bruta", sign: 1 },
  { key: "deducoes", label: "Deduções", sign: -1 },
  { key: "custos", label: "Custos", sign: -1 },
  { key: "despesas_operacionais", label: "Despesas operacionais", sign: -1 },
  { key: "despesas_financeiras", label: "Despesas financeiras", sign: -1 },
  { key: "impostos", label: "Impostos", sign: -1 },
  { key: "transitoria", label: "Transitória", sign: 0 },
  { key: "retirada", label: "Retirada", sign: -1 },
  { key: "outros", label: "Outros", sign: 1 },
];

boot().catch((error) => {
  console.error("Falha ao iniciar o sistema:", error);
  els.loginError.textContent = "Erro ao carregar o sistema. Atualize a página e tente novamente.";
  els.loginSubmit.disabled = false;
  els.loginSubmit.textContent = "Entrar";
});

async function boot() {
  try {
    bindEvents();
    setDefaultReportPeriod();
    renderAll();
    await ensureMasterUser();
    renderUsers();
    restoreSessionOrShowLogin();
    initRemoteSync()
      .then(async () => {
        await ensureMasterUser();
        renderUsers();
        if (!currentSessionUser()) {
          restoreSessionOrShowLogin();
        }
      })
      .catch((error) => {
        console.error(error);
        setSyncStatus("Sem conexão com o Sheets - usando dados locais", "error");
      });
  } finally {
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = "Entrar";
  }
}

function bindEvents() {
  els.loginForm.addEventListener("submit", handleLogin);
  els.logoutBtn.addEventListener("click", handleLogout);
  els.userForm.addEventListener("submit", saveUser);
  enhanceSearchableSelect(els.projectCustomer, { placeholder: "Buscar cliente…" });

  document.querySelectorAll("[data-invoice-kind]").forEach((button) => {
    button.addEventListener("click", () => setInvoiceKind(button.dataset.invoiceKind));
  });
  els.invoiceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveInvoice();
  });
  els.invoiceSearch.addEventListener("input", renderInvoices);
  els.invoiceGrossAmount.addEventListener("input", suggestInvoiceAccountingValue);
  els.invoiceTaxAmount.addEventListener("input", suggestInvoiceAccountingValue);
  els.invoiceLinkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.invoiceLinkDialog.close();
      return;
    }
    saveInvoiceLink();
  });
  updateInvoiceFormForKind(currentInvoiceKind);
  els.invoiceIssueDate.value = todayIso;

  document.querySelectorAll("[data-stock-tab]").forEach((button) => {
    button.addEventListener("click", () => setStockTab(button.dataset.stockTab));
  });
  els.stockItemForm.addEventListener("submit", saveStockItem);
  els.stockItemSearch.addEventListener("input", renderStockItems);
  els.stockEntryForm.addEventListener("submit", saveStockEntry);
  els.stockEntryQuantity.addEventListener("input", updateStockEntryTotalCost);
  els.stockEntryUnitCost.addEventListener("input", updateStockEntryTotalCost);
  els.stockExitForm.addEventListener("submit", saveStockExit);
  els.stockExitType.addEventListener("change", updateStockExitTypeUi);
  enhanceSearchableSelect(els.stockEntryItem, { placeholder: "Buscar item…" });
  enhanceSearchableSelect(els.stockExitItem, { placeholder: "Buscar item…" });
  els.stockEntryDate.value = todayIso;
  els.stockExitDate.value = todayIso;
  updateStockExitTypeUi();

  document.querySelectorAll("[data-crm-tab]").forEach((button) => {
    button.addEventListener("click", () => setCrmTab(button.dataset.crmTab));
  });
  document.querySelector("#newOpportunityBtn").addEventListener("click", () => openOpportunityDialog(null));
  document.querySelector("#manageSellersBtn").addEventListener("click", openSellerDialog);
  document.querySelector("#newTaskBtn").addEventListener("click", openTaskDialog);

  els.opportunityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.opportunityDialog.close();
      return;
    }
    saveOpportunity();
  });

  els.sellerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.sellerDialog.close();
      return;
    }
    addSeller();
  });

  els.interactionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.interactionDialog.close();
      return;
    }
    saveInteraction();
  });

  els.taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.taskDialog.close();
      return;
    }
    saveTask();
  });
  els.taskSellerFilter.addEventListener("change", renderTasks);
  els.taskStatusFilter.addEventListener("change", renderTasks);

  els.opportunityLostForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.opportunityLostDialog.close();
      renderPipelineBoard(); // reverte o <select> que o usuário mudou visualmente, já que nada foi salvo
      return;
    }
    confirmOpportunityLost();
  });

  els.opportunityWonForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const opportunity = pendingWonOpportunity;
    pendingWonOpportunity = null;
    els.opportunityWonDialog.close();
    if (!opportunity || event.submitter?.value === "cancel") return;
  if (event.submitter.value === "sale") convertOpportunityToSale(opportunity);
  if (event.submitter.value === "project") convertOpportunityToProject(opportunity);
  if (event.submitter.value === "contract") generateContractFromOpportunity(opportunity);
  });

  // Ganchos para vincular a oportunidade de volta à venda/projeto gerado, sem alterar
  // saveSale()/saveProject() — eles rodam DEPOIS dos handlers originais (mesma ordem de
  // registro), então checam o resultado real (o que foi de fato criado) em vez de assumir.
  els.saleDialog.addEventListener("close", () => {
    if (pendingOpportunityConversion?.kind === "sale") {
      const created = state.sales.length > pendingOpportunityConversion.saleCountBefore;
      pendingOpportunityConversion = null;
      if (created) toast("Venda gerada a partir da oportunidade.");
    }
  });

  els.projectForm.addEventListener("submit", () => {
    if (pendingOpportunityConversion?.kind === "project") {
      const { opportunityId, projectId } = pendingOpportunityConversion;
      if (state.projects.some((project) => project.id === projectId)) {
        const opportunity = state.opportunities.find((item) => item.id === opportunityId);
        if (opportunity) {
          opportunity.projectId = projectId;
          opportunity.updatedAt = new Date().toISOString();
          persist();
        }
        pendingOpportunityConversion = null;
      }
    }
  });

  els.crmReportPeriod.addEventListener("change", () => {
    updateCrmReportPeriodUi();
    renderCrmReports();
  });
  els.crmReportStart.addEventListener("input", renderCrmReports);
  els.crmReportEnd.addEventListener("input", renderCrmReports);
  updateCrmReportPeriodUi();

  els.navItems.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelector("#newTransactionBtn").addEventListener("click", () => openTransactionDialog());
  document.querySelector("#newSaleBtn").addEventListener("click", openSaleDialog);
  document.querySelector("#newSaleInlineBtn").addEventListener("click", openSaleDialog);
  document.querySelector("#newOpportunityBtn").addEventListener("click", () => openOpportunityDialog());
  document.querySelector("#clearCrmFilters").addEventListener("click", clearCrmFilters);
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
    "#crmUnitFilter",
    "#crmPipelineFilter",
    "#crmOwnerFilter",
    "#crmStageFilter",
    "#crmProjectFilter",
    "#crmSearch",
    "#crmMinValue",
    "#crmMaxValue",
    "#crmPendingOnly",
    "#crmStaleOnly",
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

  els.opportunityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.opportunityDialog.close();
      return;
    }
    saveOpportunity();
  });

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
    updateTransactionInstallmentUi();
  });

  els.transactionStatus.addEventListener("change", () => {
    if (["recebido", "pago"].includes(els.transactionStatus.value) && !els.transactionPaidDate.value) {
      els.transactionPaidDate.value = todayIso;
    }
  });

  els.transactionProjectMode.addEventListener("change", renderAllocationControls);
  els.transactionAmount.addEventListener("input", renderAllocationTotal);
  els.transactionAmount.addEventListener("input", renderTransactionInstallmentPreview);
  els.transactionDueDate.addEventListener("input", renderTransactionInstallmentPreview);
  els.transactionUseInstallments.addEventListener("change", updateTransactionInstallmentUi);
  els.transactionInstallments.addEventListener("input", renderTransactionInstallmentPreview);
  els.transactionInstallmentInterval.addEventListener("change", updateTransactionInstallmentUi);
  els.transactionCustomDays.addEventListener("input", renderTransactionInstallmentPreview);
  els.newTransactionPersonBtn.addEventListener("click", createPersonFromTransactionDialog);
  els.newTransactionProjectBtn.addEventListener("click", createProjectFromTransactionDialog);
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
  els.newBankProjectBtn.addEventListener("click", createProjectFromBankDialog);

  els.bankSyncProvider.addEventListener("change", updateBankSyncHint);
  els.bankSyncForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      els.bankSyncDialog.close();
      return;
    }
    handleBankSyncSubmit();
  });

  els.projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveProject();
  });

  document.querySelector("#projectSearch").addEventListener("input", renderProjects);
  els.projectReportSelect.addEventListener("input", renderProjectReports);
  document.querySelector("#exportProjectCsv").addEventListener("click", exportProjectsCsv);
  els.installationForm.addEventListener("submit", saveInstallation);
  els.installationSearch.addEventListener("input", renderInstallations);

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
    crmUnits: [],
    crmPipelines: [],
    opportunityStages: [],
    opportunities: [],
    opportunityHistory: [],
    projects: [],
    costCenters: [],
    bankAccounts: [],
    bankMovements: [],
    transactions: [],
    users: [],
    invoices: [],
    stockItems: [],
    stockMovements: [],
    stockLocations: [],
    installations: [],
    opportunities: [],
    interactions: [],
    tasks: [],
    sellers: [],
  });
}

function normalizeState(data) {
  const normalized = {
    people: Array.isArray(data.people) ? data.people : [],
    sales: Array.isArray(data.sales) ? data.sales : [],
    crmUnits: Array.isArray(data.crmUnits) ? data.crmUnits : [],
    crmPipelines: Array.isArray(data.crmPipelines) ? data.crmPipelines : [],
    opportunityStages: Array.isArray(data.opportunityStages) ? data.opportunityStages : [],
    opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
    opportunityHistory: Array.isArray(data.opportunityHistory) ? data.opportunityHistory : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    costCenters: Array.isArray(data.costCenters) ? data.costCenters : [],
    bankAccounts: Array.isArray(data.bankAccounts) ? data.bankAccounts : [],
    bankMovements: Array.isArray(data.bankMovements) ? data.bankMovements : [],
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    users: Array.isArray(data.users) ? data.users : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    stockItems: Array.isArray(data.stockItems) ? data.stockItems : [],
    stockMovements: Array.isArray(data.stockMovements) ? data.stockMovements : [],
    stockLocations: Array.isArray(data.stockLocations) ? data.stockLocations : [],
    installations: Array.isArray(data.installations) ? data.installations : [],
    opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
    interactions: Array.isArray(data.interactions) ? data.interactions : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    sellers: Array.isArray(data.sellers) ? data.sellers : [],
  };

  normalized.sellers = normalized.sellers.map((item) => ({
    id: crypto.randomUUID(),
    name: "",
    active: true,
    ...item,
  }));

  normalized.opportunities = normalized.opportunities.map((item) => ({
    id: crypto.randomUUID(),
    personId: "",
    title: "",
    value: 0,
    stage: "prospeccao",
    probability: 20,
    expectedCloseDate: "",
    sellerId: "",
    projectId: "",
    contractId: "",
    contractGeneratedAt: "",
    installationId: "",
    lostReason: "",
    stageChangedAt: item.createdAt || new Date().toISOString(),
    stageHistory: [],
    wonAt: "",
    lostAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...item,
  }));
  normalized.opportunities.forEach((item) => {
    if (!item.stageHistory.length) item.stageHistory = [{ stage: item.stage, at: item.createdAt }];
  });

  normalized.interactions = normalized.interactions.map((item) => ({
    id: crypto.randomUUID(),
    opportunityId: "",
    type: "ligacao",
    notes: "",
    date: "",
    nextFollowUpDate: "",
    sellerId: "",
    createdAt: new Date().toISOString(),
    ...item,
  }));

  normalized.tasks = normalized.tasks.map((item) => ({
    id: crypto.randomUUID(),
    title: "",
    description: "",
    dueDate: "",
    status: "pendente",
    opportunityId: "",
    personId: "",
    sellerId: "",
    createdAt: new Date().toISOString(),
    ...item,
  }));

  normalized.stockLocations = normalized.stockLocations.map((item) => ({
    id: crypto.randomUUID(),
    name: "",
    type: "estoque",
    active: true,
    ...item,
  }));
  if (!normalized.stockLocations.length) {
    normalized.stockLocations.push({ id: crypto.randomUUID(), name: "Estoque Principal", type: "estoque", active: true });
  }

  normalized.stockItems = normalized.stockItems.map((item) => ({
    id: crypto.randomUUID(),
    internalCode: "",
    barcode: "",
    name: "",
    description: "",
    category: "",
    subcategory: "",
    brand: "",
    model: "",
    unit: "unidade",
    primarySupplierId: "",
    locationId: normalized.stockLocations[0]?.id || "",
    quantity: 0,
    minQuantity: 0,
    maxQuantity: 0,
    averageCost: 0,
    lastPurchaseCost: 0,
    active: true,
    notes: "",
    createdAt: "",
    updatedAt: "",
    ...item,
  }));

  normalized.stockMovements = normalized.stockMovements.map((item) => ({
    id: crypto.randomUUID(),
    itemId: "",
    type: "entrada",
    date: "",
    timestamp: "",
    quantity: 0,
    unitCost: 0,
    totalCost: 0,
    balanceBefore: 0,
    balanceAfter: 0,
    projectId: "",
    supplierId: "",
    invoiceId: "",
    invoiceNumber: "",
    transactionId: "",
    exitType: "",
    reason: "",
    responsibleUserId: "",
    recipientName: "",
    fromLocationId: "",
    toLocationId: "",
    notes: "",
    createdAt: "",
    ...item,
  }));

  normalized.installations = normalized.installations.map((item) => ({
    id: crypto.randomUUID(),
    projectId: "",
    customerId: "",
    status: "programada",
    scheduledDate: "",
    team: "",
    materials: "",
    notes: "",
    conclusion: "",
    opportunityId: "",
    contractId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...item,
  }));

  normalized.invoices = normalized.invoices.map((item) => ({
    id: crypto.randomUUID(),
    kind: "servico",
    number: "",
    series: "",
    issueDate: "",
    competenceDate: "",
    dueDate: "",
    personId: "",
    document: "",
    projectId: "",
    category: "",
    grossAmount: 0,
    taxAmount: 0,
    accountingValue: 0,
    description: "",
    status: item.kind === "despesa" ? "aberto" : "emitida",
    notes: "",
    createdAt: "",
    updatedAt: "",
    ...item,
  }));

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

  if (!normalized.crmUnits.length) {
    normalized.crmUnits = [
      { id: "sorocaba-sp", name: "Sorocaba - SP" },
      { id: "maringa-pr", name: "Maringá - PR" },
    ];
  }

  if (!normalized.crmPipelines.length) {
    normalized.crmPipelines = [
      { id: "vendas", name: "Vendas" },
      { id: "manutencao", name: "Manutenção preventiva" },
      { id: "pos-venda", name: "Pós-venda" },
      { id: "projetos", name: "Projetos" },
    ];
  }

  if (!normalized.opportunityStages.length) {
    normalized.opportunityStages = getDefaultCrmStages();
  }

  normalized.opportunities = normalized.opportunities.map((item) => ({
    id: crypto.randomUUID(),
    personId: "",
    company: "",
    number: "",
    value: 0,
    unitId: normalized.crmUnits[0]?.id || "",
    pipelineId: normalized.crmPipelines[0]?.id || "",
    stageId: normalized.opportunityStages[0]?.id || "triagem",
    owner: "",
    phone: "",
    email: "",
    projectId: "",
    tags: [],
    pendingActivity: false,
    nextActivityDate: "",
    notes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMovedAt: "",
    lastContactAt: "",
    ...item,
  }));

  normalized.opportunityHistory = normalized.opportunityHistory.map((item) => ({
    id: crypto.randomUUID(),
    opportunityId: "",
    action: "registro",
    fromStageId: "",
    toStageId: "",
    user: currentCrmUser(),
    createdAt: new Date().toISOString(),
    notes: "",
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
    invoiceId: "",
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
    invoiceId: "",
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
    syncProvider: item.syncProvider || "mock",
    syncEndpoint: item.syncEndpoint || "",
    lastSyncedAt: item.lastSyncedAt || "",
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
    const response = await fetchWithTimeout(SHEETS_ENDPOINT, {}, 8000);
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

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout));
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
  let master = state.users.find((user) => user.username?.toLowerCase() === MASTER_USERNAME);
  let changed = false;

  if (!master) {
    master = {
      id: crypto.randomUUID(),
      name: "Administrador",
      username: MASTER_USERNAME,
      createdAt: new Date().toISOString(),
    };
    state.users.push(master);
    changed = true;
  }

  const storedPasswordHash = master.salt ? await hashPassword(MASTER_INITIAL_PASSWORD, master.salt) : "";
  const passwordNeedsReset = master.passwordHash !== storedPasswordHash;
  const salt = passwordNeedsReset ? randomSalt() : master.salt;
  const passwordHash = passwordNeedsReset ? await hashPassword(MASTER_INITIAL_PASSWORD, salt) : master.passwordHash;

  if (
    master.name !== "Administrador" ||
    master.username !== MASTER_USERNAME ||
    passwordNeedsReset ||
    master.role !== "administrador" ||
    master.active !== true
  ) {
    Object.assign(master, {
      name: "Administrador",
      username: MASTER_USERNAME,
      passwordHash,
      salt,
      role: "administrador",
      active: true,
    });
    changed = true;
  }

  if (changed) persist();
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
  const sessionUsername = session.username?.toLowerCase();
  const user =
    state.users.find((item) => item.id === session.userId && item.username === session.username) ||
    state.users.find((item) => item.username?.toLowerCase() === sessionUsername);
  return user && user.active ? user : null;
}

function isAdmin() {
  return currentSessionUser()?.role === "administrador";
}

function currentRole() {
  return currentSessionUser()?.role || "usuario";
}

function canAccessView(view) {
  const allowed = ROLE_ALLOWED_VIEWS[currentRole()];
  if (allowed === null) return true;
  return (allowed || ROLE_ALLOWED_VIEWS.usuario).includes(view);
}

function defaultViewForRole() {
  return currentRole() === "estoque" ? "estoque" : "dashboard";
}

// Segunda camada de proteção: além de bloquear a navegação em setView(), as funções que
// gravam dados financeiros/administrativos também se recusam a rodar se chamadas direto
// (ex.: pelo console do navegador), não só quando acionadas pela tela.
function guardViewAccess(view) {
  if (canAccessView(view)) return true;
  toast("Acesso restrito para o seu perfil.");
  return false;
}

function roleLabel(role) {
  return ROLE_LABELS[role] || "Usuário";
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
  setView(defaultViewForRole());
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
  els.navItems.forEach((item) => {
    item.classList.toggle("hidden", !canAccessView(item.dataset.view));
  });
}

function isMasterCredentials(username, password) {
  return username.toLowerCase() === MASTER_USERNAME && password === MASTER_INITIAL_PASSWORD;
}

async function handleLogin(event) {
  event.preventDefault();
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  const normalizedUsername = username.toLowerCase();

  try {
    if (isMasterCredentials(username, password)) {
      await ensureMasterUser();
      const master = state.users.find((item) => item.username?.toLowerCase() === MASTER_USERNAME);
      els.loginError.textContent = "";
      setSession(master);
      showApp();
      return;
    }

    const user = state.users.find((item) => item.username?.toLowerCase() === normalizedUsername);

    if (!user || !user.active || !user.salt || !user.passwordHash) {
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
  } catch (error) {
    console.error(error);
    els.loginError.textContent = "Não foi possível entrar. Recarregue a página e tente novamente.";
  }
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
  if (!isAdmin()) {
    toast("Apenas administradores podem cadastrar usuários.");
    return;
  }
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
  if (!isAdmin()) {
    toast("Apenas administradores podem gerenciar usuários.");
    return;
  }
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
  if (!canAccessView(view)) {
    toast("Acesso restrito para o seu perfil.");
    view = defaultViewForRole();
  }
  els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  els.views.forEach((section) => section.classList.toggle("active", section.id === view));
  els.viewTitle.textContent = viewNames[view];
}

function renderAll() {
  els.currentPeriod.textContent = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(today);
  hydrateCrmOptions();
  renderCrm();
  renderDashboard();
  renderTransactionTables();
  renderSales();
  renderProjects();
  renderProjectReports();
  renderHomologation();
  renderInstallations();
  renderBank();
  renderPeople();
  renderInvoices();
  renderStock();
  renderCrm();
  renderReports();
  hydratePersonOptions();
  hydrateSalePeople();
  hydrateProjectOptions();
  hydrateInvoicePersonOptions();
  hydrateStatusOptions();
}

function hydrateCrmOptions() {
  const unitOptions = state.crmUnits.map((unit) => `<option value="${unit.id}">${escapeHtml(unit.name)}</option>`).join("");
  const pipelineOptions = state.crmPipelines.map((pipeline) => `<option value="${pipeline.id}">${escapeHtml(pipeline.name)}</option>`).join("");
  const stageOptions = state.opportunityStages
    .sort((a, b) => a.order - b.order)
    .map((stage) => `<option value="${stage.id}">${escapeHtml(stage.name)}</option>`)
    .join("");
  const ownerOptions = [...new Set(state.opportunities.map((item) => item.owner).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((owner) => `<option value="${escapeHtml(owner)}">${escapeHtml(owner)}</option>`)
    .join("");
  const projectOptions = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(projectLabel(project))}</option>`).join("");
  const peopleOptions = state.people
    .filter((person) => person.type === "cliente" || person.type === "ambos")
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join("");

  setSelectOptions(els.crmUnitFilter, `<option value="todos">Todas</option>${unitOptions}`);
  setSelectOptions(els.crmPipelineFilter, pipelineOptions);
  setSelectOptions(els.crmOwnerFilter, `<option value="todos">Todos</option>${ownerOptions}`);
  setSelectOptions(els.crmStageFilter, `<option value="todos">Todas</option>${stageOptions}`);
  setSelectOptions(els.crmProjectFilter, `<option value="todos">Todos</option><option value="">Sem projeto</option>${projectOptions}`);
  setSelectOptions(els.opportunityUnit, unitOptions);
  setSelectOptions(els.opportunityPipeline, pipelineOptions);
  setSelectOptions(els.opportunityStage, stageOptions);
  setSelectOptions(els.opportunityProject, `<option value="">Sem projeto</option>${projectOptions}`);
  setSelectOptions(els.opportunityPerson, peopleOptions || `<option value="">Cadastre um cliente primeiro</option>`);
}

function setSelectOptions(select, html) {
  const current = select.value;
  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderCrm() {
  const opportunities = filteredOpportunities();
  document.querySelector("#crmVisibleCount").textContent = String(opportunities.length);
  document.querySelector("#crmVisibleValue").textContent = `${money(sum(opportunities.map((item) => item.value)))} no pipeline`;
  document.querySelector("#crmPendingCount").textContent = String(opportunities.filter((item) => item.pendingActivity || isActivityDue(item)).length);
  document.querySelector("#crmStaleCount").textContent = String(opportunities.filter(isOpportunityStale).length);

  els.kanbanBoard.innerHTML = state.opportunityStages
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((stage) => kanbanColumn(stage, opportunities))
    .join("");
  bindKanbanEvents();
}

function filteredOpportunities() {
  const search = els.crmSearch.value.toLowerCase().trim();
  const minValue = Number(els.crmMinValue.value || 0);
  const maxValue = Number(els.crmMaxValue.value || 0);

  return state.opportunities.filter((item) => {
    const haystack = [personName(item.personId), item.company, item.phone, item.number, projectName(item.projectId), item.owner, normalizeTags(item.tags).join(" ")].join(" ").toLowerCase();
    return (els.crmUnitFilter.value === "todos" || !els.crmUnitFilter.value || item.unitId === els.crmUnitFilter.value)
      && (!els.crmPipelineFilter.value || item.pipelineId === els.crmPipelineFilter.value)
      && (els.crmOwnerFilter.value === "todos" || !els.crmOwnerFilter.value || item.owner === els.crmOwnerFilter.value)
      && (els.crmStageFilter.value === "todos" || !els.crmStageFilter.value || item.stageId === els.crmStageFilter.value)
      && (els.crmProjectFilter.value === "todos" || item.projectId === els.crmProjectFilter.value)
      && (!search || haystack.includes(search))
      && (!minValue || Number(item.value || 0) >= minValue)
      && (!maxValue || Number(item.value || 0) <= maxValue)
      && (!els.crmPendingOnly.checked || item.pendingActivity || isActivityDue(item))
      && (!els.crmStaleOnly.checked || isOpportunityStale(item));
  });
}

function kanbanColumn(stage, opportunities) {
  const items = opportunities.filter((item) => item.stageId === stage.id);
  return `
    <section class="kanban-column" data-stage-id="${stage.id}">
      <header class="kanban-head" style="--stage-color:${stage.color}">
        <strong>${escapeHtml(stage.name)}</strong>
        <span>${items.length} oportunidade(s)</span>
        <span>${money(sum(items.map((item) => item.value)))}</span>
      </header>
      <div class="kanban-cards" data-drop-stage="${stage.id}">
        ${items.slice(0, 80).map(opportunityCard).join("")}
        ${items.length > 80 ? `<div class="muted kanban-limit">Mostrando 80 de ${items.length}</div>` : ""}
      </div>
    </section>`;
}

function opportunityCard(item) {
  const flags = [item.pendingActivity ? "Pendente" : "", isActivityDue(item) ? "Hoje/atrasada" : "", isOpportunityStale(item) ? "Sem movimento" : ""].filter(Boolean);
  return `
    <article class="opportunity-card" draggable="true" data-opportunity-id="${item.id}">
      <div class="card-actions"><button type="button" data-opportunity-action="edit" data-id="${item.id}">Editar</button></div>
      <strong>${escapeHtml(personName(item.personId))}</strong>
      <span class="muted">${escapeHtml(item.company || "Sem empresa")}</span>
      <div class="opportunity-meta"><span>${escapeHtml(item.number || "Sem número")}</span><strong>${money(item.value)}</strong></div>
      <span class="muted">${formatDate(item.lastMovedAt?.slice(0, 10) || item.updatedAt?.slice(0, 10) || todayIso)} · ${escapeHtml(item.owner || "Sem responsável")}</span>
      <span class="muted">${escapeHtml(unitName(item.unitId))}</span>
      <div class="tag-row">${normalizeTags(item.tags).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="attention-row">${flags.map((flag) => `<span>${escapeHtml(flag)}</span>`).join("")}</div>
    </article>`;
}

function bindKanbanEvents() {
  document.querySelectorAll(".opportunity-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", card.dataset.opportunityId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openOpportunityDialog(state.opportunities.find((item) => item.id === card.dataset.opportunityId));
    });
  });
  document.querySelectorAll("[data-opportunity-action='edit']").forEach((button) => {
    button.addEventListener("click", () => openOpportunityDialog(state.opportunities.find((item) => item.id === button.dataset.id)));
  });
  document.querySelectorAll("[data-drop-stage]").forEach((dropZone) => {
    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("drop-active");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drop-active"));
    dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropZone.classList.remove("drop-active");
      moveOpportunity(event.dataTransfer.getData("text/plain"), dropZone.dataset.dropStage);
    });
  });
}

function openOpportunityDialog(item = null) {
  els.opportunityForm.reset();
  hydrateCrmOptions();
  els.opportunityId.value = item?.id || "";
  els.opportunityPerson.value = item?.personId || els.opportunityPerson.value;
  els.opportunityCompany.value = item?.company || "";
  els.opportunityNumber.value = item?.number || nextOpportunityNumber();
  els.opportunityValue.value = item?.value || 0;
  els.opportunityUnit.value = item?.unitId || state.crmUnits[0]?.id || "";
  els.opportunityPipeline.value = item?.pipelineId || els.crmPipelineFilter.value || state.crmPipelines[0]?.id || "";
  els.opportunityStage.value = item?.stageId || state.opportunityStages[0]?.id || "";
  els.opportunityOwner.value = item?.owner || "";
  els.opportunityPhone.value = item?.phone || "";
  els.opportunityEmail.value = item?.email || "";
  els.opportunityProject.value = item?.projectId || "";
  els.opportunityTags.value = normalizeTags(item?.tags).join(", ");
  els.opportunityNextActivity.value = item?.nextActivityDate || "";
  els.opportunityPendingActivity.checked = Boolean(item?.pendingActivity);
  els.opportunityNotes.value = item?.notes || "";
  els.opportunityTitle.textContent = item ? "Editar oportunidade" : "Nova oportunidade";
  renderOpportunityHistory(item?.id || "");
  els.opportunityDialog.showModal();
}

function saveOpportunity() {
  const now = new Date().toISOString();
  const id = els.opportunityId.value || crypto.randomUUID();
  const existing = state.opportunities.find((item) => item.id === id);
  const data = {
    id,
    personId: els.opportunityPerson.value,
    company: els.opportunityCompany.value.trim(),
    number: els.opportunityNumber.value.trim() || nextOpportunityNumber(),
    value: Number(els.opportunityValue.value || 0),
    unitId: els.opportunityUnit.value,
    pipelineId: els.opportunityPipeline.value,
    stageId: els.opportunityStage.value,
    owner: els.opportunityOwner.value.trim(),
    phone: els.opportunityPhone.value.trim(),
    email: els.opportunityEmail.value.trim(),
    projectId: els.opportunityProject.value,
    tags: normalizeTags(els.opportunityTags.value),
    pendingActivity: els.opportunityPendingActivity.checked,
    nextActivityDate: els.opportunityNextActivity.value,
    notes: els.opportunityNotes.value.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastMovedAt: existing?.lastMovedAt || now,
    lastContactAt: existing?.lastContactAt || "",
  };

  const index = state.opportunities.findIndex((item) => item.id === id);
  if (index >= 0) {
    if (existing.stageId !== data.stageId) {
      addOpportunityHistory(id, "mudança de etapa", existing.stageId, data.stageId);
      data.lastMovedAt = now;
    }
    state.opportunities[index] = data;
  } else {
    state.opportunities.push(data);
    addOpportunityHistory(id, "criação", "", data.stageId);
  }

  persist();
  renderAll();
  els.opportunityDialog.close();
  toast("Oportunidade salva.");
}

function moveOpportunity(id, newStageId) {
  const item = state.opportunities.find((opportunity) => opportunity.id === id);
  if (!item || item.stageId === newStageId) return;
  const previousStage = item.stageId;
  item.stageId = newStageId;
  item.updatedAt = new Date().toISOString();
  item.lastMovedAt = item.updatedAt;
  addOpportunityHistory(id, "mudança de etapa", previousStage, newStageId);
  persist();
  renderCrm();
}

function renderOpportunityHistory(opportunityId) {
  const rows = state.opportunityHistory
    .filter((item) => item.opportunityId === opportunityId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  els.opportunityHistory.innerHTML = rows.length
    ? rows.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.action)}</span><span>${formatDate(row.createdAt.slice(0, 10))}</span></strong>
        <span class="muted">${escapeHtml(stageName(row.fromStageId) || "-")} → ${escapeHtml(stageName(row.toStageId) || "-")} · ${escapeHtml(row.user)}</span>
      </article>`).join("")
    : emptyMessage("Sem histórico registrado.");
}

function addOpportunityHistory(opportunityId, action, fromStageId, toStageId, notes = "") {
  state.opportunityHistory.push({
    id: crypto.randomUUID(),
    opportunityId,
    action,
    fromStageId,
    toStageId,
    user: currentCrmUser(),
    createdAt: new Date().toISOString(),
    notes,
  });
}

function clearCrmFilters() {
  els.crmUnitFilter.value = "todos";
  els.crmOwnerFilter.value = "todos";
  els.crmStageFilter.value = "todos";
  els.crmProjectFilter.value = "todos";
  els.crmSearch.value = "";
  els.crmMinValue.value = "";
  els.crmMaxValue.value = "";
  els.crmPendingOnly.checked = false;
  els.crmStaleOnly.checked = false;
  renderAll();
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((tag) => String(tag).trim()).filter(Boolean);
  return String(value || "").split(/[|,;]/).map((tag) => tag.trim()).filter(Boolean);
}

function nextOpportunityNumber() {
  return `OP-${String(state.opportunities.length + 1).padStart(4, "0")}-${todayIso.slice(5, 7)}-${todayIso.slice(2, 4)}`;
}

function stageName(stageId) {
  return state.opportunityStages.find((stage) => stage.id === stageId)?.name || "";
}

function unitName(unitId) {
  return state.crmUnits.find((unit) => unit.id === unitId)?.name || "Sem unidade";
}

function isActivityDue(item) {
  return Boolean(item.nextActivityDate && item.nextActivityDate <= todayIso);
}

function isOpportunityStale(item) {
  const ref = item.lastMovedAt?.slice(0, 10) || item.updatedAt?.slice(0, 10) || item.createdAt?.slice(0, 10);
  return ref ? daysBetween(todayIso, ref) > 15 : false;
}

function currentCrmUser() {
  return localStorage.getItem("financeiro-lumeris-user") || "Usuário local";
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
  renderSectorOverview(receberAberto, pagarAberto);

  renderBankBalances();
  renderCashflowBars();
  renderUpcoming();
  renderInvoiceDashboardKpis();
}

function renderSectorOverview(receberAberto, pagarAberto) {
  const monthSales = state.sales.filter((sale) => isInPeriod(sale.saleDate, currentMonthStart, currentMonthEnd));
  const monthSalesTotal = sum(monthSales.map((sale) => sale.total || 0));
  const activeProjects = state.projects.filter((project) => !["concluido", "cancelado"].includes(project.status));
  const scheduledInstallations = state.installations.filter((item) => ["programada", "em_andamento", "pendente"].includes(item.status));
  const stockTotal = sum(state.stockItems.map((item) => (item.quantity || 0) * (item.averageCost || 0)));
  const monthInvoices = state.invoices.filter((invoice) => invoice.kind !== "despesa" && invoice.status !== "cancelada" && isInPeriod(invoice.issueDate, currentMonthStart, currentMonthEnd));
  const monthInvoicesTotal = sum(monthInvoices.map(accountingValueOf));

  document.querySelector("#dashboardSalesTotal").textContent = money(monthSalesTotal);
  document.querySelector("#dashboardSalesSmall").textContent = `${monthSales.length} venda(s) no mês`;
  document.querySelector("#dashboardFinanceBalance").textContent = money(receberAberto - pagarAberto);
  document.querySelector("#dashboardFinanceSmall").textContent = `${money(receberAberto)} a receber / ${money(pagarAberto)} a pagar`;
  document.querySelector("#dashboardProjectsCount").textContent = String(activeProjects.length);
  document.querySelector("#dashboardProjectsSmall").textContent = `${state.projects.filter((project) => project.status === "homologacao").length} em homologação`;
  document.querySelector("#dashboardInstallationsCount").textContent = String(scheduledInstallations.length);
  document.querySelector("#dashboardInstallationsSmall").textContent = `${state.installations.filter((item) => item.status === "concluida").length} concluída(s)`;
  document.querySelector("#dashboardStockValue").textContent = money(stockTotal);
  document.querySelector("#dashboardStockSmall").textContent = `${state.stockItems.length} item(ns) cadastrados`;
  document.querySelector("#dashboardInvoicesTotal").textContent = money(monthInvoicesTotal);
  document.querySelector("#dashboardInvoicesSmall").textContent = `${monthInvoices.length} NF emitida(s) no mês`;
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

function renderInvoiceDashboardKpis() {
  const monthInvoices = state.invoices.filter((item) => isInPeriod(item.issueDate, currentMonthStart, currentMonthEnd) && item.status !== "cancelada");
  const serviceTotal = sum(monthInvoices.filter((item) => item.kind === "servico").map(accountingValueOf));
  const materialTotal = sum(monthInvoices.filter((item) => item.kind === "material").map(accountingValueOf));
  const expenseTotal = sum(monthInvoices.filter((item) => item.kind === "despesa").map(accountingValueOf));

  const monthExpenses = state.transactions.filter((item) => item.type === "pagar" && isInPeriod(item.dueDate, currentMonthStart, currentMonthEnd));
  const expenseNoInvoice = sum(monthExpenses.filter((item) => !item.invoiceId));

  const issuedPending = sum(state.invoices.filter((item) => (item.kind === "servico" || item.kind === "material") && ["emitida", "recebida_parcial"].includes(item.status)).map(accountingValueOf));
  const receivedPending = sum(state.invoices.filter((item) => item.kind === "despesa" && item.status === "aberto").map(accountingValueOf));

  document.querySelector("#kpiInvoiceMonthTotal").textContent = money(serviceTotal + materialTotal);
  document.querySelector("#kpiInvoiceServiceTotal").textContent = money(serviceTotal);
  document.querySelector("#kpiInvoiceMaterialTotal").textContent = money(materialTotal);
  document.querySelector("#kpiInvoiceExpenseTotal").textContent = money(expenseTotal);
  document.querySelector("#kpiExpenseNoInvoice").textContent = money(expenseNoInvoice);
  document.querySelector("#kpiInvoiceIssuedPending").textContent = money(issuedPending);
  document.querySelector("#kpiInvoiceReceivedPending").textContent = money(receivedPending);
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
  els.invoiceProject.innerHTML = optionalProjectOptions;
  els.stockEntryProject.innerHTML = optionalProjectOptions;
  els.stockExitProject.innerHTML = optionalProjectOptions;
  els.installationProject.innerHTML = projectOptions;
  els.installationCustomer.innerHTML = `<option value="">Sem cliente vinculado</option>${state.people
    .filter((person) => person.type === "cliente" || person.type === "ambos")
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join("")}`;
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
  return { ativo: "Ativo", orcamento: "Orçamento", homologacao: "Homologação", concluido: "Concluído", pausado: "Pausado" }[status] || status;
}

function costCenterName(costCenterId) {
  return state.costCenters.find((item) => item.id === costCenterId)?.name || "Não criado";
}

function renderHomologation() {
  const rows = state.projects
    .filter((project) => ["homologacao", "orcamento", "ativo"].includes(project.status))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  els.homologationTable.innerHTML = rows.length
    ? rows.map((project) => `
      <tr>
        <td>${escapeHtml(projectLabel(project))}</td>
        <td>${escapeHtml(personName(project.customerId))}</td>
        <td>${projectStatusLabel(project.status)}</td>
        <td>${formatDate(project.startDate)}</td>
        <td>${formatDate(project.endDate)}</td>
        <td>
          <button type="button" data-homologation-action="edit" data-id="${project.id}">Editar projeto</button>
          <button type="button" data-homologation-action="installation" data-id="${project.id}">Programar instalação</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6">${emptyMessage("Nenhum projeto em homologação.")}</td></tr>`;

  document.querySelectorAll("[data-homologation-action]").forEach((button) => {
    button.addEventListener("click", () => handleHomologationAction(button.dataset.homologationAction, button.dataset.id));
  });
}

function handleHomologationAction(action, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (action === "edit") {
    setView("projetos");
    handleProjectAction("edit", projectId);
    return;
  }
  if (action === "installation") {
    openInstallationForProject(project);
  }
}

function openInstallationForProject(project) {
  setView("instalacoes");
  resetInstallationForm();
  els.installationProject.value = project.id;
  els.installationCustomer.value = project.customerId;
  els.installationScheduledDate.value = project.endDate || "";
  toast("Revise os dados e salve a instalação.");
}

function resetInstallationForm() {
  els.installationForm.reset();
  els.installationId.value = "";
  hydrateProjectOptions();
}

function installationStatusLabel(status) {
  return {
    programada: "Programada",
    em_andamento: "Em andamento",
    concluida: "Concluída",
    pendente: "Pendente",
    cancelada: "Cancelada",
  }[status] || status;
}

function renderInstallations() {
  hydrateProjectOptions();
  const search = (els.installationSearch.value || "").toLowerCase().trim();
  const rows = state.installations
    .filter((item) => `${projectName(item.projectId)} ${personName(item.customerId)} ${item.team} ${item.status}`.toLowerCase().includes(search))
    .sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));

  els.installationList.innerHTML = rows.length
    ? rows.map((item) => `
      <article class="person-item">
        <strong><span>${escapeHtml(projectName(item.projectId))}</span><span>${installationStatusLabel(item.status)}</span></strong>
        <span class="muted">${escapeHtml(personName(item.customerId))} · ${formatDate(item.scheduledDate)} · ${escapeHtml(item.team || "Sem equipe")}</span>
        <span class="muted">${escapeHtml(item.materials || "Materiais não informados")}</span>
        <div class="row-actions">
          <button type="button" data-installation-action="edit" data-id="${item.id}">Editar</button>
          <button type="button" data-installation-action="complete" data-id="${item.id}">Concluir</button>
        </div>
      </article>`).join("")
    : emptyMessage("Nenhuma instalação cadastrada.");

  document.querySelectorAll("[data-installation-action]").forEach((button) => {
    button.addEventListener("click", () => handleInstallationAction(button.dataset.installationAction, button.dataset.id));
  });
}

function saveInstallation(event) {
  event.preventDefault();
  const id = els.installationId.value || crypto.randomUUID();
  const existing = state.installations.find((item) => item.id === id);
  const project = state.projects.find((item) => item.id === els.installationProject.value);
  const data = {
    id,
    projectId: els.installationProject.value,
    customerId: els.installationCustomer.value || project?.customerId || "",
    status: els.installationStatus.value,
    scheduledDate: els.installationScheduledDate.value,
    team: els.installationTeam.value.trim(),
    materials: els.installationMaterials.value.trim(),
    notes: els.installationNotes.value.trim(),
    conclusion: els.installationConclusion.value.trim(),
    opportunityId: existing?.opportunityId || "",
    contractId: existing?.contractId || "",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const index = state.installations.findIndex((item) => item.id === id);
  if (index >= 0) state.installations[index] = data;
  else state.installations.push(data);

  persist();
  renderAll();
  resetInstallationForm();
  toast("Instalação salva.");
}

function handleInstallationAction(action, id) {
  const installation = state.installations.find((item) => item.id === id);
  if (!installation) return;
  if (action === "edit") {
    els.installationId.value = installation.id;
    els.installationProject.value = installation.projectId;
    els.installationCustomer.value = installation.customerId;
    els.installationStatus.value = installation.status;
    els.installationScheduledDate.value = installation.scheduledDate;
    els.installationTeam.value = installation.team;
    els.installationMaterials.value = installation.materials;
    els.installationNotes.value = installation.notes;
    els.installationConclusion.value = installation.conclusion;
    return;
  }
  if (action === "complete") {
    installation.status = "concluida";
    installation.updatedAt = new Date().toISOString();
    persist();
    renderAll();
    toast("Instalação concluída.");
  }
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
      const { added, duplicates } = mergeBankMovements(parsed.movements);
      persist();
      renderAll();
      setView("banco");
      toast(`${added} movimento(s) importado(s). ${duplicates} duplicado(s) ignorado(s).`);
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

function mergeBankMovements(newMovements) {
  const existingKeys = new Set(state.bankMovements.flatMap((item) => [item.importKey, item.naturalKey].filter(Boolean)));
  const fresh = newMovements.filter((item) => !existingKeys.has(item.importKey) && !existingKeys.has(item.naturalKey));
  state.bankMovements.push(...fresh);
  return { added: fresh.length, duplicates: newMovements.length - fresh.length };
}

async function fetchStatementViaBackend(bankKey, account, { start, end }) {
  const endpoint = (account.syncEndpoint || "").trim().replace(/\/$/, "");
  if (!endpoint) {
    throw new Error(`Informe a URL do backend de integração do ${bankKey === "inter" ? "Inter" : "Santander"} para essa conta.`);
  }

  const response = await fetch(`${endpoint}/${bankKey}/extrato`, {
    method: "POST",
    body: JSON.stringify({ accountId: account.accountId, bankId: account.bankId, start, end }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Falha ao buscar extrato no backend.");

  const accountKey = account.accountKey || `${account.bankId}-${account.accountId}`;
  const movements = (result.movements || []).map((raw) => normalizeProviderMovement(raw, account, accountKey));
  hydrateBankMovementNaturalKeys(movements);
  movements.forEach((movement) => {
    movement.importKey = movement.importKey || movement.naturalKey;
  });
  return movements;
}

function normalizeProviderMovement(raw, account, accountKey) {
  const signedAmount = Number(raw.signedAmount ?? (raw.type === "saida" ? -Math.abs(raw.amount) : Math.abs(raw.amount)));
  return {
    id: crypto.randomUUID(),
    importKey: raw.fitid ? `${accountKey}-${raw.fitid}` : "",
    naturalKey: "",
    fitid: raw.fitid || "",
    accountId: account.accountId,
    bankId: account.bankId,
    filename: `api-${account.syncProvider}`,
    date: raw.date,
    type: signedAmount >= 0 ? "entrada" : "saida",
    documentNumber: raw.documentNumber || raw.fitid || "",
    description: cleanText(raw.description || "Movimento bancário"),
    amount: Math.abs(signedAmount),
    signedAmount,
    category: "",
    dreGroup: signedAmount >= 0 ? "receita_bruta" : "despesas_operacionais",
    notes: "",
    transactionId: "",
    importedAt: new Date().toISOString(),
  };
}

function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

async function mockFetchStatement(account, { start, end }) {
  const descriptions = MOCK_DESCRIPTIONS[account.bankId] || MOCK_DESCRIPTIONS["077"];
  const accountKey = account.accountKey || `${account.bankId}-${account.accountId}`;
  const movements = [];
  const endDate = parseDate(end);
  let cursor = parseDate(start);

  while (cursor <= endDate) {
    const dateStr = toIso(cursor);
    const rand = seededRandom(`${accountKey}-${dateStr}`);
    const count = Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const type = rand() > 0.55 ? "entrada" : "saida";
      const pool = descriptions[type];
      const description = pool[Math.floor(rand() * pool.length)];
      const amount = Math.round((20 + rand() * 3000) * 100) / 100;
      const documentNumber = `MOCK${dateStr.replace(/-/g, "")}${i}`;
      const signedAmount = type === "entrada" ? amount : -amount;
      const naturalBaseKey = buildBankMovementNaturalKey(accountKey, { date: dateStr, amount: signedAmount, documentNumber, description, fitid: documentNumber });
      movements.push({
        id: crypto.randomUUID(),
        importKey: `${naturalBaseKey}-1`,
        naturalKey: `${naturalBaseKey}-1`,
        fitid: documentNumber,
        accountId: account.accountId,
        bankId: account.bankId,
        filename: "sincronizacao-simulada",
        date: dateStr,
        type,
        documentNumber,
        description,
        amount,
        signedAmount,
        category: "",
        dreGroup: type === "entrada" ? "receita_bruta" : "despesas_operacionais",
        notes: "",
        transactionId: "",
        importedAt: new Date().toISOString(),
      });
    }
    cursor = addDays(cursor, 1);
  }

  return movements;
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

function renderBankSyncList() {
  const accounts = latestBankAccounts();
  els.bankSyncList.innerHTML = accounts.length
    ? accounts.map((account) => {
        const provider = BANK_PROVIDERS[account.syncProvider] || BANK_PROVIDERS.mock;
        const lastSync = account.lastSyncedAt ? `Última sincronização: ${new Date(account.lastSyncedAt).toLocaleString("pt-BR")}` : "Nunca sincronizado por API";
        return `
      <article class="bank-sync-item">
        <div>
          <strong>${escapeHtml(account.bankId)} · Conta ${escapeHtml(account.accountId || "não identificada")}</strong>
          <span class="muted">${escapeHtml(provider.label)} · ${lastSync}</span>
        </div>
        <button class="secondary-btn" type="button" data-sync-account="${escapeHtml(account.accountKey || `${account.bankId}-${account.accountId}`)}">Sincronizar extrato</button>
      </article>`;
      }).join("")
    : emptyMessage("Importe um OFX ao menos uma vez para cadastrar uma conta antes de sincronizar por API.");

  document.querySelectorAll("[data-sync-account]").forEach((button) => {
    button.addEventListener("click", () => openBankSyncDialog(button.dataset.syncAccount));
  });
}

function openBankSyncDialog(accountKey) {
  const account = state.bankAccounts.find((item) => (item.accountKey || `${item.bankId}-${item.accountId}`) === accountKey);
  if (!account) return;

  els.bankSyncForm.reset();
  els.bankSyncAccountKey.value = accountKey;
  els.bankSyncTitle.textContent = `Sincronizar extrato · ${account.bankId} · Conta ${account.accountId || ""}`;
  els.bankSyncProvider.value = account.syncProvider || "mock";
  els.bankSyncEndpoint.value = account.syncEndpoint || "";
  els.bankSyncEnd.value = todayIso;
  els.bankSyncStart.value = toIso(addDays(today, -30));
  updateBankSyncHint();
  els.bankSyncDialog.showModal();
}

function updateBankSyncHint() {
  const provider = BANK_PROVIDERS[els.bankSyncProvider.value] || BANK_PROVIDERS.mock;
  els.bankSyncEndpointWrap.classList.toggle("hidden", !provider.requiresEndpoint);
  els.bankSyncHint.textContent = provider.requiresEndpoint
    ? "Esse provedor chama um backend próprio (que você hospeda) responsável por conversar com o banco de verdade — o site não guarda nem envia credenciais."
    : "Gera movimentos de teste determinísticos para o período escolhido, útil para validar deduplicação e conciliação antes de conectar a API real.";
}

async function handleBankSyncSubmit() {
  if (!guardViewAccess("banco")) return;
  const accountKey = els.bankSyncAccountKey.value;
  const account = state.bankAccounts.find((item) => (item.accountKey || `${item.bankId}-${item.accountId}`) === accountKey);
  if (!account) return;

  const providerKey = els.bankSyncProvider.value;
  const provider = BANK_PROVIDERS[providerKey] || BANK_PROVIDERS.mock;
  const start = els.bankSyncStart.value;
  const end = els.bankSyncEnd.value;
  if (!start || !end || start > end) {
    toast("Informe um período válido para sincronizar.");
    return;
  }

  account.syncProvider = providerKey;
  account.syncEndpoint = els.bankSyncEndpoint.value.trim();

  els.bankSyncSubmit.disabled = true;
  els.bankSyncSubmit.textContent = "Buscando…";
  try {
    const movements = await provider.fetchStatement(account, { start, end });
    const { added, duplicates } = mergeBankMovements(movements);
    account.lastSyncedAt = new Date().toISOString();
    persist();
    renderAll();
    els.bankSyncDialog.close();
    toast(`${added} movimento(s) importado(s). ${duplicates} duplicado(s) ignorado(s).`);
  } catch (error) {
    console.error(error);
    toast(error.message || "Não foi possível sincronizar o extrato.");
  } finally {
    els.bankSyncSubmit.disabled = false;
    els.bankSyncSubmit.textContent = "Buscar extrato";
  }
}

function renderBank() {
  renderBankSyncList();
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
  if (item.transactionId || item.invoiceId) return "conciliado";
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
  hydrateBankInvoiceMatches(movement);
  els.bankMatchInvoice.value = movement.invoiceId || "";
  els.bankDialog.showModal();
}

function createProjectFromBankDialog() {
  if (!guardViewAccess("projetos")) return;
  const movement = state.bankMovements.find((item) => item.id === els.bankMovementId.value);
  const suggestedName = movement?.description ? movement.description.slice(0, 80) : "";
  const name = window.prompt("Nome do novo projeto:", suggestedName);
  if (!name || !name.trim()) return;

  const project = {
    id: crypto.randomUUID(),
    code: "",
    name: name.trim(),
    customerId: "",
    status: "ativo",
    startDate: todayIso,
    endDate: "",
    contractValue: movement?.type === "entrada" ? Number(movement.amount || 0) : 0,
    expectedCosts: movement?.type === "saida" ? Number(movement.amount || 0) : 0,
    targetMargin: 20,
    costCenterId: crypto.randomUUID(),
    notes: movement ? `Criado durante conciliação bancária: ${movement.description}` : "Criado durante conciliação bancária.",
  };

  state.projects.push(project);
  upsertCostCenter(project);
  persist();
  hydrateProjectOptions();
  els.bankProject.value = project.id;
  renderProjects();
  renderProjectReports();
  renderHomologation();
  toast("Projeto criado e selecionado na conciliação.");
}

function hydrateBankInvoiceMatches(movement) {
  const wantKinds = movement.type === "entrada" ? ["servico", "material"] : ["despesa"];
  const matches = state.invoices
    .filter((item) => wantKinds.includes(item.kind))
    .filter((item) => item.status !== "cancelada")
    .map((item) => ({ item, score: invoiceMatchScore(movement, item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  els.bankMatchInvoice.innerHTML = [
    `<option value="">Sem vínculo com NF</option>`,
    ...matches.map(({ item }) => `<option value="${item.id}">NF ${escapeHtml(item.number)} · ${escapeHtml(personName(item.personId))} · valor contábil ${money(item.accountingValue)}</option>`),
  ].join("");
}

function invoiceMatchScore(movement, invoice) {
  const amountDiff = Math.abs(movement.amount - invoice.accountingValue);
  return amountDiff > 0.02 ? -1 : 100 - amountDiff;
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
  if (!guardViewAccess("banco")) return;
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

  movement.invoiceId = els.bankMatchInvoice.value;
  if (movement.invoiceId) {
    const invoice = state.invoices.find((item) => item.id === movement.invoiceId);
    if (invoice && invoice.status !== "cancelada") {
      invoice.status = invoice.kind === "despesa" ? "paga" : "recebida_total";
    }
  }

  persist();
  renderAll();
  els.bankDialog.close();
  toast("Movimento bancário salvo.");
}

function unlinkBankMovement(movement) {
  movement.invoiceId = "";
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

// ---- Estoque ----

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

function stockItemLabel(item) {
  return item.internalCode ? `${item.internalCode} - ${item.name}` : item.name;
}

function stockAlertLevel(item) {
  if (item.quantity <= 0) return "zero";
  if (item.quantity < item.minQuantity) return "below-min";
  if (item.maxQuantity > 0 && item.quantity > item.maxQuantity) return "above-max";
  return "";
}

function stockUserName(id) {
  const user = state.users.find((entry) => entry.id === id);
  return user ? user.name || user.username : "—";
}

function appendStockMovement(entry) {
  state.stockMovements.push({
    id: crypto.randomUUID(),
    itemId: "",
    type: "entrada",
    date: todayIso,
    timestamp: new Date().toISOString(),
    quantity: 0,
    unitCost: 0,
    totalCost: 0,
    balanceBefore: 0,
    balanceAfter: 0,
    projectId: "",
    supplierId: "",
    invoiceId: "",
    invoiceNumber: "",
    transactionId: "",
    exitType: "",
    reason: "",
    responsibleUserId: currentSessionUser()?.id || "",
    recipientName: "",
    fromLocationId: "",
    toLocationId: "",
    notes: "",
    createdAt: new Date().toISOString(),
    ...entry,
  });
}

function setStockTab(tab) {
  currentStockTab = tab;
  document.querySelectorAll("[data-stock-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.stockTab === tab);
  });
  document.querySelectorAll("[data-stock-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.stockPanel !== tab);
  });
}

function hydrateStockCatalogOptions() {
  const suppliers = state.people.filter((person) => person.type === "fornecedor" || person.type === "ambos");
  const supplierOptions = suppliers.length
    ? suppliers.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">Cadastre um fornecedor primeiro</option>`;
  els.stockSupplier.innerHTML = `<option value="">Sem fornecedor principal</option>${supplierOptions}`;
  els.stockEntrySupplier.innerHTML = `<option value="">Sem fornecedor</option>${supplierOptions}`;

  els.stockLocation.innerHTML = state.stockLocations
    .filter((location) => location.active)
    .map((location) => `<option value="${location.id}">${escapeHtml(location.name)}</option>`)
    .join("");

  const activeItems = state.stockItems.filter((item) => item.active);
  const itemOptions = activeItems.length
    ? activeItems.map((item) => `<option value="${item.id}">${escapeHtml(stockItemLabel(item))}</option>`).join("")
    : `<option value="">Cadastre um item primeiro</option>`;
  els.stockEntryItem.innerHTML = itemOptions;
  els.stockExitItem.innerHTML = itemOptions;
  refreshSearchableSelect(els.stockEntryItem);
  refreshSearchableSelect(els.stockExitItem);

  const openInvoices = state.invoices.filter((item) => item.kind === "despesa" && item.status !== "cancelada");
  els.stockEntryInvoice.innerHTML = [
    `<option value="">Sem NF vinculada</option>`,
    ...openInvoices.map((item) => `<option value="${item.id}">NF ${escapeHtml(item.number)} · ${escapeHtml(personName(item.personId))}</option>`),
  ].join("");

  const payables = state.transactions
    .filter((item) => item.type === "pagar")
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
    .slice(0, 40);
  els.stockEntryTransaction.innerHTML = [
    `<option value="">Sem conta a pagar vinculada</option>`,
    ...payables.map((item) => `<option value="${item.id}">${formatDate(item.dueDate)} · ${escapeHtml(item.description)} · ${money(item.amount)}</option>`),
  ].join("");
}

function resetStockItemForm() {
  els.stockItemForm.reset();
  els.stockItemId.value = "";
  els.stockItemFormTitle.textContent = "Novo item";
  els.stockActive.checked = true;
}

function saveStockItem(event) {
  event.preventDefault();
  const id = els.stockItemId.value || crypto.randomUUID();
  const existing = state.stockItems.find((item) => item.id === id);

  const item = {
    id,
    internalCode: els.stockInternalCode.value.trim(),
    barcode: els.stockBarcode.value.trim(),
    name: els.stockName.value.trim(),
    description: els.stockDescription.value.trim(),
    category: els.stockCategory.value.trim(),
    subcategory: els.stockSubcategory.value.trim(),
    brand: els.stockBrand.value.trim(),
    model: els.stockModel.value.trim(),
    unit: els.stockUnit.value,
    primarySupplierId: els.stockSupplier.value,
    locationId: els.stockLocation.value,
    quantity: existing?.quantity || 0,
    minQuantity: Number(els.stockMinQuantity.value || 0),
    maxQuantity: Number(els.stockMaxQuantity.value || 0),
    averageCost: existing?.averageCost || 0,
    lastPurchaseCost: existing?.lastPurchaseCost || 0,
    active: els.stockActive.checked,
    notes: els.stockNotes.value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const index = state.stockItems.findIndex((entry) => entry.id === id);
  if (index >= 0) state.stockItems[index] = item;
  else state.stockItems.push(item);

  persist();
  renderAll();
  resetStockItemForm();
  toast("Item de estoque salvo.");
}

function renderStockItems() {
  const search = els.stockItemSearch.value.toLowerCase().trim();
  const items = state.stockItems
    .filter((item) => `${item.internalCode} ${item.name} ${item.category} ${item.barcode}`.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.stockItemTable.innerHTML = items.length
    ? items.map(stockItemRow).join("")
    : `<tr><td colspan="7">${emptyMessage("Nenhum item cadastrado.")}</td></tr>`;

  document.querySelectorAll("[data-stock-item-action]").forEach((button) => {
    button.addEventListener("click", () => handleStockItemAction(button.dataset.stockItemAction, button.dataset.id));
  });
}

function stockItemRow(item) {
  const totalValue = item.quantity * item.averageCost;
  const alertLevel = stockAlertLevel(item);
  return `
    <tr class="${alertLevel ? `stock-alert-${alertLevel}` : ""}">
      <td>
        <strong>${escapeHtml(item.name)}</strong>
        <span class="muted block">${escapeHtml(item.internalCode || "sem código")} · ${STOCK_UNIT_LABELS[item.unit] || item.unit}</span>
      </td>
      <td>${escapeHtml(item.category || "-")}</td>
      <td class="money">${formatQuantity(item.quantity)}</td>
      <td class="money">${money(item.averageCost)}</td>
      <td class="money">${money(totalValue)}</td>
      <td>${item.active ? `<span class="status baixado">Ativo</span>` : `<span class="status vencido">Inativo</span>`}</td>
      <td>
        <div class="row-actions">
          <button type="button" data-stock-item-action="edit" data-id="${item.id}">Editar</button>
          <button type="button" data-stock-item-action="toggle-active" data-id="${item.id}">${item.active ? "Inativar" : "Ativar"}</button>
          <button type="button" data-stock-item-action="delete" data-id="${item.id}">Excluir</button>
        </div>
      </td>
    </tr>`;
}

function handleStockItemAction(action, id) {
  const item = state.stockItems.find((entry) => entry.id === id);
  if (!item) return;

  if (action === "edit") {
    els.stockItemId.value = item.id;
    els.stockInternalCode.value = item.internalCode;
    els.stockBarcode.value = item.barcode;
    els.stockName.value = item.name;
    els.stockDescription.value = item.description;
    els.stockCategory.value = item.category;
    els.stockSubcategory.value = item.subcategory;
    els.stockBrand.value = item.brand;
    els.stockModel.value = item.model;
    els.stockUnit.value = item.unit;
    els.stockSupplier.value = item.primarySupplierId;
    els.stockLocation.value = item.locationId;
    els.stockMinQuantity.value = item.minQuantity;
    els.stockMaxQuantity.value = item.maxQuantity;
    els.stockActive.checked = item.active;
    els.stockNotes.value = item.notes;
    els.stockItemFormTitle.textContent = `Editar item · ${item.name}`;
    return;
  }

  if (action === "toggle-active") {
    item.active = !item.active;
    persist();
    renderAll();
    toast(item.active ? "Item ativado." : "Item inativado.");
    return;
  }

  if (action === "delete") {
    const hasMovements = state.stockMovements.some((movement) => movement.itemId === id);
    if (hasMovements || item.quantity) {
      toast("Não é possível excluir: item tem movimentações ou saldo em estoque. Inative-o em vez disso.");
      return;
    }
    state.stockItems = state.stockItems.filter((entry) => entry.id !== id);
    persist();
    renderAll();
    toast("Item excluído.");
  }
}

function updateStockEntryTotalCost() {
  const quantity = Number(els.stockEntryQuantity.value || 0);
  const unitCost = Number(els.stockEntryUnitCost.value || 0);
  els.stockEntryTotalCost.value = roundCurrency(quantity * unitCost);
}

function resetStockEntryForm() {
  els.stockEntryForm.reset();
  els.stockEntryDate.value = todayIso;
  els.stockEntryTotalCost.value = "";
}

function saveStockEntry(event) {
  event.preventDefault();
  const item = state.stockItems.find((entry) => entry.id === els.stockEntryItem.value);
  if (!item) {
    toast("Selecione um item.");
    return;
  }

  const quantity = Number(els.stockEntryQuantity.value || 0);
  const unitCost = Number(els.stockEntryUnitCost.value || 0);
  if (quantity <= 0) {
    toast("Informe uma quantidade válida.");
    return;
  }

  const balanceBefore = item.quantity;
  const newQuantity = roundCurrency(balanceBefore + quantity);
  const newAverageCost = newQuantity > 0 ? roundCurrency((balanceBefore * item.averageCost + quantity * unitCost) / newQuantity) : 0;

  item.quantity = newQuantity;
  item.averageCost = newAverageCost;
  item.lastPurchaseCost = unitCost;
  item.updatedAt = new Date().toISOString();

  appendStockMovement({
    itemId: item.id,
    type: "entrada",
    date: els.stockEntryDate.value || todayIso,
    quantity,
    unitCost,
    totalCost: roundCurrency(quantity * unitCost),
    balanceBefore,
    balanceAfter: newQuantity,
    projectId: els.stockEntryProject.value,
    supplierId: els.stockEntrySupplier.value,
    invoiceId: els.stockEntryInvoice.value,
    invoiceNumber: els.stockEntryInvoiceNumber.value.trim(),
    transactionId: els.stockEntryTransaction.value,
    notes: els.stockEntryNotes.value.trim(),
  });

  persist();
  renderAll();
  resetStockEntryForm();
  toast("Entrada de material registrada. Custo médio recalculado.");
}

function renderStockEntryList() {
  const rows = state.stockMovements
    .filter((movement) => movement.type === "entrada")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  els.stockEntryList.innerHTML = rows.length
    ? rows.map((movement) => {
        const item = state.stockItems.find((entry) => entry.id === movement.itemId);
        return `
      <article class="report-item">
        <strong><span>${escapeHtml(item ? stockItemLabel(item) : "Item removido")}</span><span>${money(movement.totalCost)}</span></strong>
        <span class="muted">${formatDate(movement.date)} · ${formatQuantity(movement.quantity)} ${item ? STOCK_UNIT_LABELS[item.unit] || item.unit : ""} · ${money(movement.unitCost)}/un · ${movement.supplierId ? personName(movement.supplierId) : "sem fornecedor"} · ${stockUserName(movement.responsibleUserId)}</span>
      </article>`;
      }).join("")
    : emptyMessage("Nenhuma entrada registrada.");
}

function updateStockExitTypeUi() {
  els.stockExitProjectWrap.classList.toggle("hidden", els.stockExitType.value !== "consumo_projeto");
}

function resetStockExitForm() {
  els.stockExitForm.reset();
  els.stockExitDate.value = todayIso;
  updateStockExitTypeUi();
}

function saveStockExit(event) {
  event.preventDefault();
  const item = state.stockItems.find((entry) => entry.id === els.stockExitItem.value);
  if (!item) {
    toast("Selecione um item.");
    return;
  }

  const quantity = Number(els.stockExitQuantity.value || 0);
  if (quantity <= 0) {
    toast("Informe uma quantidade válida.");
    return;
  }
  if (quantity > item.quantity) {
    toast(`Estoque insuficiente: disponível ${formatQuantity(item.quantity)} ${STOCK_UNIT_LABELS[item.unit] || item.unit}.`);
    return;
  }

  const exitType = els.stockExitType.value;
  const projectId = exitType === "consumo_projeto" ? els.stockExitProject.value : "";
  const balanceBefore = item.quantity;
  const unitCost = item.averageCost;
  const totalCost = roundCurrency(quantity * unitCost);
  const exitDate = els.stockExitDate.value || todayIso;

  item.quantity = roundCurrency(balanceBefore - quantity);
  item.updatedAt = new Date().toISOString();

  let transactionId = "";
  if (exitType === "consumo_projeto" && projectId) {
    // status "pago" sem paidDate de propósito: o caixa já saiu na compra original do material
    // (entrada de estoque). Isso faz o custo entrar no resultado do projeto (que soma todo
    // "pagar" alocado, pago ou não) sem duplicar o KPI de "Resultado do mês" da empresa
    // (que só conta transações com data de pagamento no mês).
    const transaction = {
      id: crypto.randomUUID(),
      type: "pagar",
      personId: "",
      description: `Consumo de estoque: ${stockItemLabel(item)} (${formatQuantity(quantity)} ${STOCK_UNIT_LABELS[item.unit] || item.unit})`,
      category: item.category || "Material de estoque",
      dreGroup: defaultDreGroup("pagar"),
      dueDate: exitDate,
      amount: totalCost,
      status: "pago",
      paidDate: "",
      notes: "Gerado automaticamente pela saída de estoque para projeto.",
      directProjectCost: true,
      projectId,
      allocations: [{ projectId, amount: totalCost }],
      saleId: "",
      installmentNumber: "",
      installmentTotal: "",
      bankMovementId: "",
      invoiceId: "",
      updatedAt: new Date().toISOString(),
    };
    state.transactions.push(transaction);
    transactionId = transaction.id;
  }

  appendStockMovement({
    itemId: item.id,
    type: "saida",
    date: exitDate,
    quantity,
    unitCost,
    totalCost,
    balanceBefore,
    balanceAfter: item.quantity,
    projectId,
    exitType,
    reason: els.stockExitReason.value.trim(),
    recipientName: els.stockExitRecipient.value.trim(),
    transactionId,
    notes: els.stockExitNotes.value.trim(),
  });

  persist();
  renderAll();
  resetStockExitForm();
  toast("Saída de material registrada.");
}

function renderStockExitList() {
  const rows = state.stockMovements
    .filter((movement) => movement.type === "saida")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  els.stockExitList.innerHTML = rows.length
    ? rows.map((movement) => {
        const item = state.stockItems.find((entry) => entry.id === movement.itemId);
        return `
      <article class="report-item">
        <strong><span>${escapeHtml(item ? stockItemLabel(item) : "Item removido")}</span><span>${money(movement.totalCost)}</span></strong>
        <span class="muted">${formatDate(movement.date)} · ${formatQuantity(movement.quantity)} ${item ? STOCK_UNIT_LABELS[item.unit] || item.unit : ""} · ${STOCK_EXIT_TYPE_LABELS[movement.exitType] || movement.exitType} · ${movement.projectId ? projectName(movement.projectId) : "Sem projeto"} · ${stockUserName(movement.responsibleUserId)}</span>
      </article>`;
      }).join("")
    : emptyMessage("Nenhuma saída registrada.");
}

function renderStockAlerts() {
  const items = state.stockItems.filter((item) => item.active);
  els.stockAlertBelowMin.textContent = String(items.filter((item) => item.quantity > 0 && item.quantity < item.minQuantity).length);
  els.stockAlertZero.textContent = String(items.filter((item) => item.quantity <= 0).length);
  els.stockAlertAboveMax.textContent = String(items.filter((item) => item.maxQuantity > 0 && item.quantity > item.maxQuantity).length);
}

function renderStockPurchaseNeed() {
  const rows = state.stockItems
    .filter((item) => item.active && item.quantity < item.minQuantity)
    .map((item) => ({ item, suggestion: Math.max(0, (item.maxQuantity || item.minQuantity) - item.quantity) }))
    .sort((a, b) => b.suggestion - a.suggestion);

  els.stockPurchaseNeedTable.innerHTML = rows.length
    ? rows.map(({ item, suggestion }) => `
      <tr>
        <td>${escapeHtml(stockItemLabel(item))}</td>
        <td class="money">${formatQuantity(item.quantity)}</td>
        <td class="money">${formatQuantity(item.minQuantity)}</td>
        <td class="money">${formatQuantity(item.maxQuantity)}</td>
        <td class="money">${formatQuantity(suggestion)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">${emptyMessage("Nenhum item abaixo do estoque mínimo.")}</td></tr>`;
}

function renderStock() {
  hydrateStockCatalogOptions();
  renderStockItems();
  renderStockEntryList();
  renderStockExitList();
  renderStockAlerts();
  renderStockPurchaseNeed();
}

// ---- CRM ----

function sellerName(id) {
  return state.sellers.find((seller) => seller.id === id)?.name || "Sem vendedor";
}

function opportunityLabel(opportunity) {
  return `${opportunity.title} · ${personName(opportunity.personId)}`;
}

function daysSince(isoDateOrDateTime) {
  if (!isoDateOrDateTime) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(isoDateOrDateTime).getTime()) / 86400000));
}

function setCrmTab(tab) {
  currentCrmTab = tab;
  document.querySelectorAll("[data-crm-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.crmTab === tab);
  });
  document.querySelectorAll("[data-crm-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.crmPanel !== tab);
  });
}

function hydrateSellerOptions() {
  const activeSellers = state.sellers.filter((seller) => seller.active);
  const options = activeSellers.map((seller) => `<option value="${seller.id}">${escapeHtml(seller.name)}</option>`).join("");
  els.opportunitySeller.innerHTML = `<option value="">Sem vendedor</option>${options}`;
  els.taskSeller.innerHTML = `<option value="">Sem vendedor</option>${options}`;
  els.taskSellerFilter.innerHTML = `<option value="todos">Todos os vendedores</option>${options}`;
}

function openSellerDialog() {
  els.sellerName.value = "";
  renderSellerList();
  els.sellerDialog.showModal();
}

function renderSellerList() {
  els.sellerList.innerHTML = state.sellers.length
    ? state.sellers.map((seller) => `
      <article class="person-item">
        <strong><span>${escapeHtml(seller.name)}</span><span>${seller.active ? "Ativo" : "Inativo"}</span></strong>
        <div class="row-actions">
          <button type="button" data-seller-action="toggle" data-id="${seller.id}">${seller.active ? "Inativar" : "Ativar"}</button>
        </div>
      </article>`).join("")
    : emptyMessage("Nenhum vendedor cadastrado.");

  document.querySelectorAll("[data-seller-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const seller = state.sellers.find((entry) => entry.id === button.dataset.id);
      if (!seller) return;
      seller.active = !seller.active;
      persist();
      renderSellerList();
      renderAll();
    });
  });
}

function addSeller() {
  const name = els.sellerName.value.trim();
  if (!name) {
    toast("Informe o nome do vendedor.");
    return;
  }
  state.sellers.push({ id: crypto.randomUUID(), name, active: true });
  els.sellerName.value = "";
  persist();
  renderSellerList();
  renderAll();
  toast("Vendedor adicionado.");
}

function findOrCreatePersonByName(name, fallbackType = "cliente") {
  const trimmed = name.trim();
  const existing = state.people.find((person) => person.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.id;
  const person = { id: crypto.randomUUID(), type: fallbackType, name: trimmed, document: "", contact: "" };
  state.people.push(person);
  return person.id;
}

function hydrateOpportunityPersonSuggestions() {
  const clients = state.people.filter((person) => person.type === "cliente" || person.type === "ambos");
  els.opportunityPersonSuggestions.innerHTML = clients.map((person) => `<option value="${escapeHtml(person.name)}"></option>`).join("");
}

function openOpportunityDialog(opportunity) {
  els.opportunityForm.reset();
  hydrateOpportunityPersonSuggestions();
  if (opportunity) {
    els.opportunityFormTitle.textContent = "Editar oportunidade";
    els.opportunityId.value = opportunity.id;
    els.opportunityTitle.value = opportunity.title;
    els.opportunityPersonName.value = personName(opportunity.personId);
    els.opportunityValue.value = opportunity.value;
    els.opportunityProbability.value = opportunity.probability;
    els.opportunityExpectedCloseDate.value = opportunity.expectedCloseDate;
    els.opportunitySeller.value = opportunity.sellerId;
    els.opportunityStage.value = opportunity.stage;
  } else {
    els.opportunityFormTitle.textContent = "Nova oportunidade";
    els.opportunityId.value = "";
    els.opportunityProbability.value = 20;
    els.opportunityStage.value = "prospeccao";
  }
  els.opportunityDialog.showModal();
}

function saveOpportunity() {
  const id = els.opportunityId.value || crypto.randomUUID();
  const existing = state.opportunities.find((item) => item.id === id);
  const personNameInput = els.opportunityPersonName.value.trim();
  if (!personNameInput) {
    toast("Informe o cliente ou lead.");
    return;
  }

  const personId = findOrCreatePersonByName(personNameInput);
  const stage = els.opportunityStage.value;
  const now = new Date().toISOString();
  const stageChanged = existing && existing.stage !== stage;

  const opportunity = {
    id,
    personId,
    title: els.opportunityTitle.value.trim(),
    value: Number(els.opportunityValue.value || 0),
    stage,
    probability: Number(els.opportunityProbability.value || 0),
    expectedCloseDate: els.opportunityExpectedCloseDate.value,
    sellerId: els.opportunitySeller.value,
    projectId: existing?.projectId || "",
    lostReason: existing?.lostReason || "",
    stageChangedAt: stageChanged || !existing ? now : existing.stageChangedAt,
    stageHistory: existing ? [...existing.stageHistory] : [{ stage, at: now }],
    wonAt: existing?.wonAt || (stage === "ganho" ? now : ""),
    lostAt: existing?.lostAt || (stage === "perdido" ? now : ""),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (stageChanged) opportunity.stageHistory.push({ stage, at: now });

  const index = state.opportunities.findIndex((item) => item.id === id);
  if (index >= 0) state.opportunities[index] = opportunity;
  else state.opportunities.push(opportunity);

  persist();
  renderAll();
  els.opportunityDialog.close();
  toast("Oportunidade salva.");
}

function renderPipelineBoard() {
  els.pipelineBoard.innerHTML = OPPORTUNITY_STAGES.map((stageInfo) => {
    const items = state.opportunities
      .filter((item) => item.stage === stageInfo.key)
      .sort((a, b) => (b.stageChangedAt || "").localeCompare(a.stageChangedAt || ""));
    const total = sum(items.map((item) => item.value));
    return `
      <div class="pipeline-column">
        <div class="pipeline-column-head">
          <span>${stageInfo.label}</span>
          <small>${items.length} · ${money(total)}</small>
        </div>
        ${items.map(pipelineCard).join("") || emptyMessage("Sem oportunidades.")}
      </div>`;
  }).join("");

  document.querySelectorAll("[data-opportunity-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const opportunity = state.opportunities.find((item) => item.id === el.dataset.opportunityEdit);
      if (opportunity) openOpportunityDialog(opportunity);
    });
  });
  document.querySelectorAll("[data-opportunity-stage-select]").forEach((select) => {
    select.addEventListener("change", () => handleStageSelect(select.dataset.opportunityStageSelect, select.value));
  });
}

function pipelineCard(opportunity) {
  const daysStalled = daysSince(opportunity.stageChangedAt);
  const stalled = daysStalled >= 14 && !["ganho", "perdido"].includes(opportunity.stage);
  return `
    <article class="pipeline-card ${stalled ? "stalled" : ""}">
      <strong data-opportunity-edit="${opportunity.id}">${escapeHtml(opportunity.title)}</strong>
      <span>${escapeHtml(personName(opportunity.personId))}</span>
      <span class="muted">${money(opportunity.value)} · ${escapeHtml(sellerName(opportunity.sellerId))}</span>
      <span class="muted">${daysStalled} dia(s) neste estágio</span>
      <select data-opportunity-stage-select="${opportunity.id}">
        ${OPPORTUNITY_STAGES.map((stageInfo) => `<option value="${stageInfo.key}" ${stageInfo.key === opportunity.stage ? "selected" : ""}>${stageInfo.label}</option>`).join("")}
      </select>
    </article>`;
}

function handleStageSelect(opportunityId, newStage) {
  const opportunity = state.opportunities.find((item) => item.id === opportunityId);
  if (!opportunity || newStage === opportunity.stage) return;

  if (newStage === "perdido") {
    openOpportunityLostDialog(opportunity);
    return;
  }

  changeOpportunityStage(opportunity, newStage);
  if (newStage === "ganho") openOpportunityWonDialog(opportunity);
}

function changeOpportunityStage(opportunity, newStage) {
  const now = new Date().toISOString();
  opportunity.stage = newStage;
  opportunity.stageChangedAt = now;
  opportunity.stageHistory.push({ stage: newStage, at: now });
  opportunity.updatedAt = now;
  if (newStage === "ganho" && !opportunity.wonAt) opportunity.wonAt = now;
  if (newStage === "perdido" && !opportunity.lostAt) opportunity.lostAt = now;
  persist();
  renderAll();
}

function openOpportunityLostDialog(opportunity) {
  els.opportunityLostId.value = opportunity.id;
  els.opportunityLostReason.value = "";
  els.opportunityLostDialog.showModal();
}

function confirmOpportunityLost() {
  const opportunity = state.opportunities.find((item) => item.id === els.opportunityLostId.value);
  if (!opportunity) return;
  opportunity.lostReason = els.opportunityLostReason.value.trim();
  changeOpportunityStage(opportunity, "perdido");
  els.opportunityLostDialog.close();
  toast("Oportunidade marcada como perdida.");
}

function openOpportunityWonDialog(opportunity) {
  pendingWonOpportunity = opportunity;
  els.opportunityWonSummary.textContent = `${opportunity.title} · ${personName(opportunity.personId)} · ${money(opportunity.value)}`;
  els.opportunityWonDialog.showModal();
}

function convertOpportunityToSale(opportunity) {
  pendingOpportunityConversion = { kind: "sale", opportunityId: opportunity.id, saleCountBefore: state.sales.length };
  openSaleDialog();
  els.salePerson.value = opportunity.personId;
  els.saleDescription.value = opportunity.title;
  els.saleTotal.value = opportunity.value;
  renderInstallmentPreview();
}

function convertOpportunityToProject(opportunity) {
  const projectId = crypto.randomUUID();
  pendingOpportunityConversion = { kind: "project", opportunityId: opportunity.id, projectId };
  setView("projetos");
  els.projectForm.reset();
  els.projectId.value = projectId;
  els.projectName.value = opportunity.title;
  els.projectCustomer.value = opportunity.personId;
  refreshSearchableSelect(els.projectCustomer);
  els.projectContractValue.value = opportunity.value;
  els.projectStatus.value = "orcamento";
  toast("Revise os dados do projeto e clique em Salvar projeto para concluir a conversão.");
}

function generateContractFromOpportunity(opportunity) {
  if (opportunity.contractId) {
    toast("Essa oportunidade já possui contrato gerado.");
    setView("homologacao");
    return;
  }

  const now = new Date().toISOString();
  const contractId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  const dueDate = opportunity.expectedCloseDate || todayIso;
  const title = opportunity.title || `Contrato ${personName(opportunity.personId)}`;
  const amount = Number(opportunity.value || 0);

  const project = {
    id: projectId,
    code: "",
    name: title,
    customerId: opportunity.personId,
    status: "homologacao",
    startDate: todayIso,
    endDate: dueDate,
    contractValue: amount,
    expectedCosts: 0,
    targetMargin: 20,
    costCenterId: crypto.randomUUID(),
    notes: `Gerado automaticamente pelo CRM. Contrato: ${contractId}`,
  };
  state.projects.push(project);
  upsertCostCenter(project);

  state.sales.push({
    id: saleId,
    personId: opportunity.personId,
    saleDate: todayIso,
    description: title,
    category: "Contrato CRM",
    projectId,
    total: amount,
    installments: 1,
    dreGroup: "receita_bruta",
    notes: `Contrato gerado no CRM: ${contractId}`,
    contractId,
    opportunityId: opportunity.id,
    createdAt: now,
  });

  state.transactions.push({
    id: crypto.randomUUID(),
    type: "receber",
    personId: opportunity.personId,
    description: `${title} - Contrato CRM`,
    category: "Contrato CRM",
    dreGroup: "receita_bruta",
    dueDate,
    amount,
    status: "aberto",
    paidDate: "",
    notes: `Gerado automaticamente pelo CRM. Contrato: ${contractId}`,
    saleId,
    installmentNumber: 1,
    installmentTotal: 1,
    projectId,
    allocations: [{ projectId, amount }],
    contractId,
    bankMovementId: "",
    invoiceId: "",
    updatedAt: now,
  });

  state.installations.push({
    id: installationId,
    projectId,
    customerId: opportunity.personId,
    status: "programada",
    scheduledDate: dueDate,
    team: "",
    materials: "",
    notes: `Programação criada automaticamente pelo contrato ${contractId}.`,
    conclusion: "",
    opportunityId: opportunity.id,
    contractId,
    createdAt: now,
    updatedAt: now,
  });

  opportunity.projectId = projectId;
  opportunity.contractId = contractId;
  opportunity.contractGeneratedAt = now;
  opportunity.installationId = installationId;
  opportunity.updatedAt = now;

  persist();
  renderAll();
  setView("homologacao");
  toast("Contrato gerado: recebimento, projeto e instalação foram criados.");
}

function latestInteractionFor(opportunityId) {
  const matches = state.interactions
    .filter((item) => item.opportunityId === opportunityId)
    .sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt));
  return matches[0] || null;
}

function renderFollowUpList() {
  const activeOpportunities = state.opportunities.filter((item) => !["ganho", "perdido"].includes(item.stage));
  const rows = activeOpportunities
    .map((opportunity) => ({ opportunity, lastInteraction: latestInteractionFor(opportunity.id) }))
    .map((row) => ({ ...row, nextFollowUp: row.lastInteraction?.nextFollowUpDate || "" }))
    .sort((a, b) => (a.nextFollowUp || "9999-99-99").localeCompare(b.nextFollowUp || "9999-99-99"));

  els.followUpList.innerHTML = rows.length
    ? rows.map(({ opportunity, lastInteraction, nextFollowUp }) => {
        const overdue = nextFollowUp && nextFollowUp < todayIso;
        const lastContactText = lastInteraction ? ` · Último contato: ${INTERACTION_TYPE_LABELS[lastInteraction.type] || lastInteraction.type} em ${formatDate(lastInteraction.date)}` : "";
        return `
      <article class="report-item ${overdue ? "follow-up-overdue" : ""}">
        <strong><span>${escapeHtml(opportunity.title)} · ${escapeHtml(personName(opportunity.personId))}</span><span>${money(opportunity.value)}</span></strong>
        <span class="muted">${nextFollowUp ? `Próximo follow-up: ${formatDate(nextFollowUp)}` : "Sem follow-up agendado"} · ${escapeHtml(sellerName(opportunity.sellerId))}${lastContactText}</span>
        <div class="row-actions">
          <button type="button" data-register-contact="${opportunity.id}">Registrar contato</button>
        </div>
      </article>`;
      }).join("")
    : emptyMessage("Nenhuma oportunidade ativa no funil.");

  document.querySelectorAll("[data-register-contact]").forEach((button) => {
    button.addEventListener("click", () => openInteractionDialog(button.dataset.registerContact));
  });
}

function openInteractionDialog(opportunityId) {
  const opportunity = state.opportunities.find((item) => item.id === opportunityId);
  els.interactionForm.reset();
  els.interactionOpportunityId.value = opportunityId;
  els.interactionDate.value = todayIso;
  document.querySelector("#interactionDialogTitle").textContent = opportunity ? `Registrar contato · ${opportunity.title}` : "Registrar contato";
  els.interactionDialog.showModal();
}

function saveInteraction() {
  const opportunityId = els.interactionOpportunityId.value;
  const opportunity = state.opportunities.find((item) => item.id === opportunityId);
  if (!opportunity) return;

  state.interactions.push({
    id: crypto.randomUUID(),
    opportunityId,
    type: els.interactionType.value,
    notes: els.interactionNotes.value.trim(),
    date: els.interactionDate.value || todayIso,
    nextFollowUpDate: els.interactionNextFollowUpDate.value,
    sellerId: opportunity.sellerId,
    createdAt: new Date().toISOString(),
  });

  persist();
  renderAll();
  els.interactionDialog.close();
  toast("Contato registrado.");
}

function hydrateTaskOptions() {
  const activeOpportunities = state.opportunities.filter((item) => !["ganho", "perdido"].includes(item.stage));
  els.taskOpportunity.innerHTML = [
    `<option value="">Nenhuma</option>`,
    ...activeOpportunities.map((item) => `<option value="${item.id}">${escapeHtml(opportunityLabel(item))}</option>`),
  ].join("");

  const clients = state.people.filter((person) => person.type === "cliente" || person.type === "ambos");
  els.taskPerson.innerHTML = [
    `<option value="">Nenhum</option>`,
    ...clients.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`),
  ].join("");
}

function openTaskDialog() {
  els.taskForm.reset();
  els.taskId.value = "";
  els.taskDueDate.value = todayIso;
  hydrateTaskOptions();
  els.taskDialog.showModal();
}

function saveTask() {
  const id = els.taskId.value || crypto.randomUUID();
  const existing = state.tasks.find((item) => item.id === id);
  const task = {
    id,
    title: els.taskTitle.value.trim(),
    description: els.taskDescription.value.trim(),
    dueDate: els.taskDueDate.value,
    status: existing?.status || "pendente",
    opportunityId: els.taskOpportunity.value,
    personId: els.taskPerson.value,
    sellerId: els.taskSeller.value,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  const index = state.tasks.findIndex((item) => item.id === id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.push(task);

  persist();
  renderAll();
  els.taskDialog.close();
  toast("Tarefa salva.");
}

function taskComputedStatus(task) {
  if (task.status === "concluida") return "concluida";
  if (task.dueDate && task.dueDate < todayIso) return "atrasada";
  return "pendente";
}

function taskStatusLabel(status) {
  return { pendente: "Pendente", concluida: "Concluída", atrasada: "Atrasada" }[status] || status;
}

function completeTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  task.status = "concluida";
  persist();
  renderAll();
  toast("Tarefa concluída.");
}

function renderTasks() {
  const sellerFilter = els.taskSellerFilter.value;
  const statusFilter = els.taskStatusFilter.value;

  let tasks = state.tasks.slice();
  if (sellerFilter && sellerFilter !== "todos") tasks = tasks.filter((task) => task.sellerId === sellerFilter);
  if (statusFilter === "pendente") tasks = tasks.filter((task) => task.status !== "concluida");
  if (statusFilter === "concluida") tasks = tasks.filter((task) => task.status === "concluida");

  const weekLimit = toIso(addDays(today, 7));
  const overdue = [];
  const dueToday = [];
  const dueWeek = [];
  const dueLater = [];

  tasks.forEach((task) => {
    const computed = taskComputedStatus(task);
    if (computed === "concluida") {
      dueLater.push(task);
      return;
    }
    if (computed === "atrasada") overdue.push(task);
    else if (task.dueDate === todayIso) dueToday.push(task);
    else if (task.dueDate && task.dueDate <= weekLimit) dueWeek.push(task);
    else dueLater.push(task);
  });

  renderTaskGroup(els.tasksOverdueList, overdue, "Nenhuma tarefa atrasada.");
  renderTaskGroup(els.tasksTodayList, dueToday, "Nenhuma tarefa para hoje.");
  renderTaskGroup(els.tasksWeekList, dueWeek, "Nenhuma tarefa nos próximos 7 dias.");
  renderTaskGroup(els.tasksLaterList, dueLater, "Nenhuma tarefa futura.");
}

function renderTaskGroup(container, tasks, emptyText) {
  container.innerHTML = tasks.length
    ? tasks
        .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
        .map((task) => `
      <article class="report-item">
        <strong><span>${escapeHtml(task.title)}</span><span>${taskStatusLabel(taskComputedStatus(task))}</span></strong>
        <span class="muted">${formatDate(task.dueDate)} · ${escapeHtml(sellerName(task.sellerId))}${task.description ? ` · ${escapeHtml(task.description)}` : ""}</span>
        ${task.status !== "concluida" ? `<div class="row-actions"><button type="button" data-complete-task="${task.id}">Concluir</button></div>` : ""}
      </article>`).join("")
    : emptyMessage(emptyText);

  document.querySelectorAll("[data-complete-task]").forEach((button) => {
    button.addEventListener("click", () => completeTask(button.dataset.completeTask));
  });
}

function updateCrmReportPeriodUi() {
  const isCustom = els.crmReportPeriod.value === "personalizado";
  els.crmReportStartWrap.classList.toggle("hidden", !isCustom);
  els.crmReportEndWrap.classList.toggle("hidden", !isCustom);
  if (isCustom && !els.crmReportStart.value) {
    els.crmReportStart.value = currentMonthStart;
    els.crmReportEnd.value = currentMonthEnd;
  }
}

function getCrmReportPeriod() {
  const mode = els.crmReportPeriod.value;
  if (mode === "trimestre") {
    const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
    const start = new Date(today.getFullYear(), quarterStartMonth, 1);
    const end = new Date(today.getFullYear(), quarterStartMonth + 3, 0);
    return { start: toIso(start), end: toIso(end) };
  }
  if (mode === "personalizado") {
    return { start: els.crmReportStart.value || currentMonthStart, end: els.crmReportEnd.value || currentMonthEnd };
  }
  return { start: currentMonthStart, end: currentMonthEnd };
}

function renderCrmReports() {
  const period = getCrmReportPeriod();
  const won = state.opportunities.filter((item) => item.stage === "ganho" && isInPeriod((item.wonAt || "").slice(0, 10), period.start, period.end));
  const lost = state.opportunities.filter((item) => item.stage === "perdido" && isInPeriod((item.lostAt || "").slice(0, 10), period.start, period.end));

  const avgTicket = won.length ? sum(won.map((item) => item.value)) / won.length : 0;
  const avgCloseDays = won.length
    ? won.reduce((total, item) => total + Math.max(0, daysBetween((item.wonAt || "").slice(0, 10), (item.createdAt || "").slice(0, 10))), 0) / won.length
    : 0;

  els.crmAvgTicket.textContent = money(avgTicket);
  els.crmAvgCloseTime.textContent = `${avgCloseDays.toFixed(1)} dias`;
  els.crmWonCount.textContent = String(won.length);
  els.crmLostCount.textContent = String(lost.length);

  renderStageConversionReport();
  renderSellerRanking(won, lost);
}

function renderStageConversionReport() {
  const rows = OPPORTUNITY_STAGES.filter((stageInfo) => !["ganho", "perdido"].includes(stageInfo.key)).map((stageInfo) => {
    const stageIndex = OPPORTUNITY_STAGES.findIndex((entry) => entry.key === stageInfo.key);
    const reached = state.opportunities.filter((item) => item.stageHistory.some((entry) => entry.stage === stageInfo.key));
    const advanced = reached.filter((item) =>
      item.stageHistory.some((entry) => OPPORTUNITY_STAGES.findIndex((s) => s.key === entry.stage) > stageIndex)
    );
    const rate = reached.length ? (advanced.length / reached.length) * 100 : 0;
    return { stageInfo, reachedCount: reached.length, advancedCount: advanced.length, rate };
  });

  els.crmStageConversionReport.innerHTML = rows.map((row) => `
    <article class="report-item">
      <strong><span>${row.stageInfo.label}</span><span>${row.rate.toFixed(1)}%</span></strong>
      <span class="muted">${row.advancedCount} de ${row.reachedCount} avançaram para o próximo estágio</span>
    </article>`).join("");
}

function renderSellerRanking(won, lost) {
  const sellerIds = new Set([...won.map((item) => item.sellerId), ...lost.map((item) => item.sellerId)].filter(Boolean));
  const rows = [...sellerIds]
    .map((sellerId) => {
      const wonBySeller = won.filter((item) => item.sellerId === sellerId);
      const lostBySeller = lost.filter((item) => item.sellerId === sellerId);
      const total = sum(wonBySeller.map((item) => item.value));
      const conversion = wonBySeller.length + lostBySeller.length ? (wonBySeller.length / (wonBySeller.length + lostBySeller.length)) * 100 : 0;
      return { sellerId, total, count: wonBySeller.length, conversion };
    })
    .sort((a, b) => b.total - a.total);

  els.crmSellerRankingTable.innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(sellerName(row.sellerId))}</td>
        <td class="money">${money(row.total)}</td>
        <td>${row.count}</td>
        <td>${row.conversion.toFixed(1)}%</td>
      </tr>`).join("")
    : `<tr><td colspan="4">${emptyMessage("Sem negócios fechados no período.")}</td></tr>`;
}

function renderCrm() {
  hydrateSellerOptions();
  renderPipelineBoard();
  renderFollowUpList();
  renderTasks();
  renderCrmReports();
}

// ---- Notas Fiscais ----

function setInvoiceKind(kind) {
  currentInvoiceKind = kind;
  document.querySelectorAll("[data-invoice-kind]").forEach((button) => {
    button.classList.toggle("active", button.dataset.invoiceKind === kind);
  });
  resetInvoiceForm();
  renderInvoices();
}

function resetInvoiceForm() {
  els.invoiceForm.reset();
  els.invoiceId.value = "";
  els.invoiceIssueDate.value = todayIso;
  updateInvoiceFormForKind(currentInvoiceKind);
  suggestInvoiceAccountingValue();
}

function updateInvoiceFormForKind(kind) {
  const meta = INVOICE_KIND_META[kind] || INVOICE_KIND_META.servico;
  els.invoiceKind.value = kind;
  els.invoiceFormTitle.textContent = els.invoiceId.value ? `Editar ${meta.label}` : `Nova ${meta.label}`;
  els.invoicePersonLabel.textContent = meta.personLabel;
  els.invoiceCompetenceWrap.classList.toggle("hidden", meta.direction !== "emitida");
  els.invoiceDueDateWrap.classList.toggle("hidden", meta.direction !== "recebida");
  els.invoiceStatus.innerHTML = meta.statusOptions.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");
  hydrateInvoicePersonOptions();
}

function hydrateInvoicePersonOptions() {
  const meta = INVOICE_KIND_META[els.invoiceKind.value] || INVOICE_KIND_META.servico;
  const wantType = meta.direction === "emitida" ? "cliente" : "fornecedor";
  const people = state.people.filter((person) => person.type === "ambos" || person.type === wantType);
  els.invoicePerson.innerHTML = people.length
    ? people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">Cadastre ${wantType === "cliente" ? "um cliente" : "um fornecedor"} primeiro</option>`;
}

function suggestInvoiceAccountingValue() {
  if (els.invoiceId.value) return;
  const gross = Number(els.invoiceGrossAmount.value || 0);
  const tax = Number(els.invoiceTaxAmount.value || 0);
  els.invoiceAccountingValue.value = roundCurrency(gross - tax);
}

function accountingValueOf(invoice) {
  return invoice.accountingValue || 0;
}

function linkedTransactionsForInvoice(invoiceId) {
  return state.transactions.filter((item) => item.invoiceId === invoiceId);
}

function invoiceStatusLabel(invoice) {
  const meta = INVOICE_KIND_META[invoice.kind] || INVOICE_KIND_META.servico;
  return meta.statusOptions.find((option) => option.value === invoice.status)?.label || invoice.status;
}

function saveInvoice() {
  if (!guardViewAccess("notasfiscais")) return;
  const kind = els.invoiceKind.value;
  const meta = INVOICE_KIND_META[kind] || INVOICE_KIND_META.servico;
  const id = els.invoiceId.value || crypto.randomUUID();
  const number = els.invoiceNumber.value.trim();
  const personId = els.invoicePerson.value;

  const duplicate = state.invoices.some((item) => item.id !== id && item.kind === kind && item.personId === personId && item.number.trim().toLowerCase() === number.toLowerCase());
  if (duplicate) {
    toast("Já existe uma NF com esse número para esse cliente/fornecedor.");
    return;
  }

  const existing = state.invoices.find((item) => item.id === id);
  const invoice = {
    id,
    kind,
    number,
    series: els.invoiceSeries.value.trim(),
    issueDate: els.invoiceIssueDate.value,
    competenceDate: meta.direction === "emitida" ? els.invoiceCompetenceDate.value : "",
    dueDate: meta.direction === "recebida" ? els.invoiceDueDate.value : "",
    personId,
    document: els.invoiceDocument.value.trim(),
    projectId: els.invoiceProject.value,
    category: els.invoiceCategory.value.trim(),
    grossAmount: Number(els.invoiceGrossAmount.value || 0),
    taxAmount: Number(els.invoiceTaxAmount.value || 0),
    accountingValue: Number(els.invoiceAccountingValue.value || 0),
    description: els.invoiceDescription.value.trim(),
    status: els.invoiceStatus.value,
    notes: els.invoiceNotes.value.trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const index = state.invoices.findIndex((item) => item.id === id);
  if (index >= 0) state.invoices[index] = invoice;
  else state.invoices.push(invoice);

  persist();
  renderAll();
  resetInvoiceForm();
  toast("Nota fiscal salva.");
}

function renderInvoices() {
  const search = els.invoiceSearch.value.toLowerCase().trim();
  const invoices = state.invoices
    .filter((item) => item.kind === currentInvoiceKind)
    .filter((item) => `${item.number} ${personName(item.personId)} ${item.description}`.toLowerCase().includes(search))
    .sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || ""));

  els.invoiceList.innerHTML = invoices.length
    ? invoices.map(invoiceRow).join("")
    : emptyMessage("Nenhuma nota fiscal cadastrada.");

  document.querySelectorAll("[data-invoice-action]").forEach((button) => {
    button.addEventListener("click", () => handleInvoiceAction(button.dataset.invoiceAction, button.dataset.id));
  });
}

function invoiceRow(invoice) {
  const linked = linkedTransactionsForInvoice(invoice.id);
  const linkText = linked.length ? `${linked.length} parcela(s) vinculada(s) (${money(sum(linked))})` : "sem vínculo financeiro";
  return `
    <article class="person-item">
      <strong><span>NF ${escapeHtml(invoice.number)}${invoice.series ? "/" + escapeHtml(invoice.series) : ""} · ${escapeHtml(personName(invoice.personId))}</span><span>${money(invoice.accountingValue)}</span></strong>
      <span class="muted">${formatDate(invoice.issueDate)} · ${invoiceStatusLabel(invoice)} · ${linkText}</span>
      <div class="row-actions">
        <button type="button" data-invoice-action="edit" data-id="${invoice.id}">Editar</button>
        <button type="button" data-invoice-action="link" data-id="${invoice.id}">Vincular</button>
        <button type="button" data-invoice-action="delete" data-id="${invoice.id}">Excluir</button>
      </div>
    </article>`;
}

function handleInvoiceAction(action, id) {
  const invoice = state.invoices.find((item) => item.id === id);
  if (!invoice) return;

  if (action === "edit") {
    setInvoiceKind(invoice.kind);
    els.invoiceId.value = invoice.id;
    els.invoiceNumber.value = invoice.number;
    els.invoiceSeries.value = invoice.series;
    els.invoicePerson.value = invoice.personId;
    els.invoiceDocument.value = invoice.document;
    els.invoiceIssueDate.value = invoice.issueDate;
    els.invoiceCompetenceDate.value = invoice.competenceDate;
    els.invoiceDueDate.value = invoice.dueDate;
    els.invoiceProject.value = invoice.projectId;
    els.invoiceCategory.value = invoice.category;
    els.invoiceGrossAmount.value = invoice.grossAmount;
    els.invoiceTaxAmount.value = invoice.taxAmount;
    els.invoiceAccountingValue.value = invoice.accountingValue;
    els.invoiceStatus.value = invoice.status;
    els.invoiceDescription.value = invoice.description;
    els.invoiceNotes.value = invoice.notes;
    els.invoiceFormTitle.textContent = `Editar ${(INVOICE_KIND_META[invoice.kind] || INVOICE_KIND_META.servico).label}`;
    return;
  }

  if (action === "link") {
    openInvoiceLinkDialog(invoice);
    return;
  }

  if (action === "delete") {
    if (linkedTransactionsForInvoice(invoice.id).length) {
      toast("Desvincule os lançamentos financeiros antes de excluir esta NF.");
      return;
    }
    state.bankMovements.filter((item) => item.invoiceId === invoice.id).forEach((item) => {
      item.invoiceId = "";
    });
    state.invoices = state.invoices.filter((item) => item.id !== invoice.id);
    persist();
    renderAll();
    toast("Nota fiscal excluída.");
  }
}

function openInvoiceLinkDialog(invoice) {
  const meta = INVOICE_KIND_META[invoice.kind] || INVOICE_KIND_META.servico;
  const wantType = meta.direction === "emitida" ? "receber" : "pagar";

  els.invoiceLinkId.value = invoice.id;
  els.invoiceLinkTitle.textContent = `Vincular NF ${invoice.number} a lançamentos`;
  els.invoiceLinkSummary.textContent = `Valor contábil da NF: ${money(invoice.accountingValue)}`;

  const candidates = state.transactions
    .filter((item) => item.type === wantType)
    .filter((item) => !item.invoiceId || item.invoiceId === invoice.id)
    .filter((item) => !invoice.personId || item.personId === invoice.personId)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  els.invoiceLinkList.innerHTML = candidates.length
    ? candidates.map((item) => `
      <label class="checkbox-line invoice-link-row">
        <input type="checkbox" data-link-transaction="${item.id}" ${item.invoiceId === invoice.id ? "checked" : ""} />
        ${formatDate(item.dueDate)} · ${escapeHtml(item.description)} · ${money(item.amount)} · ${statusLabel(item.status)}
      </label>`).join("")
    : emptyMessage("Nenhum lançamento compatível (mesmo cliente/fornecedor, sem NF vinculada).");

  els.invoiceLinkDialog.showModal();
}

function saveInvoiceLink() {
  if (!guardViewAccess("notasfiscais")) return;
  const invoiceId = els.invoiceLinkId.value;
  const checkboxes = els.invoiceLinkList.querySelectorAll("[data-link-transaction]");

  checkboxes.forEach((box) => {
    const transaction = state.transactions.find((item) => item.id === box.dataset.linkTransaction);
    if (!transaction) return;
    if (box.checked) {
      transaction.invoiceId = invoiceId;
    } else if (transaction.invoiceId === invoiceId) {
      transaction.invoiceId = "";
    }
  });

  persist();
  renderAll();
  els.invoiceLinkDialog.close();
  toast("Vínculo atualizado.");
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

  const inUse = state.transactions.some((item) => item.personId === id) || state.sales.some((sale) => sale.personId === id) || state.invoices.some((item) => item.personId === id);
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
  els.transactionUseInstallments.checked = false;
  els.transactionInstallments.value = 1;
  els.transactionInstallmentInterval.value = "monthly";
  els.transactionCustomDays.value = 30;
  renderAllocationControls();
  renderAllocationRows(allocations);
  updateTransactionInstallmentUi();
  els.transactionNotes.value = item?.notes || "";
  els.transactionTitle.textContent = item ? "Editar lançamento" : "Novo lançamento";
  els.transactionDialog.showModal();
}

function saveTransaction() {
  const type = els.transactionType.value;
  if (!guardViewAccess(type === "receber" ? "receber" : "pagar")) return;
  const status = els.transactionStatus.value;
  const existing = state.transactions.find((item) => item.id === els.transactionId.value);
  const allocations = getTransactionAllocations();
  if (!validateAllocations(Number(els.transactionAmount.value), allocations)) {
    toast("A soma do rateio precisa ser igual ao valor total do lançamento.");
    return;
  }

  const shouldGenerateInstallments =
    type === "receber" &&
    !existing &&
    els.transactionUseInstallments.checked &&
    Number(els.transactionInstallments.value || 1) > 1;

  if (shouldGenerateInstallments) {
    saveTransactionInstallments(type, status, allocations);
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

function saveTransactionInstallments(type, status, allocations) {
  const total = Number(els.transactionAmount.value);
  const count = Number(els.transactionInstallments.value || 1);
  const installments = buildInstallments(total, count, els.transactionDueDate.value, els.transactionInstallmentInterval.value, Number(els.transactionCustomDays.value));
  const batchId = crypto.randomUUID();

  installments.forEach((installment) => {
    const installmentAllocations = scaleAllocations(allocations, installment.amount, total);
    state.transactions.push({
      id: crypto.randomUUID(),
      type,
      personId: els.transactionPerson.value,
      description: `${els.transactionDescription.value.trim()} - Parcela ${installment.number}/${count}`,
      category: els.transactionCategory.value.trim(),
      dreGroup: els.transactionDreGroup.value,
      dueDate: installment.dueDate,
      amount: installment.amount,
      status,
      paidDate: status === "recebido" ? els.transactionPaidDate.value || todayIso : "",
      notes: els.transactionNotes.value.trim(),
      directProjectCost: false,
      projectId: installmentAllocations.length === 1 ? installmentAllocations[0].projectId : "",
      allocations: installmentAllocations,
      saleId: batchId,
      installmentNumber: installment.number,
      installmentTotal: count,
      bankMovementId: "",
      updatedAt: new Date().toISOString(),
    });
  });

  persist();
  renderAll();
  els.transactionDialog.close();
  toast(`${count} parcelas geradas na previsão de recebíveis.`);
}

function scaleAllocations(allocations, installmentAmount, totalAmount) {
  if (!allocations.length || !totalAmount) return [];
  const scaled = allocations.map((allocation) => ({
    projectId: allocation.projectId,
    amount: roundCurrency((allocation.amount / totalAmount) * installmentAmount),
  }));
  const diff = roundCurrency(installmentAmount - allocationTotal(scaled));
  if (scaled.length && Math.abs(diff) >= 0.01) {
    scaled[scaled.length - 1].amount = roundCurrency(scaled[scaled.length - 1].amount + diff);
  }
  return scaled;
}

function hydratePersonOptions() {
  const type = els.transactionType.value;
  const people = state.people.filter((person) => person.type === "ambos" || (type === "receber" ? person.type === "cliente" : person.type === "fornecedor"));
  els.transactionPerson.innerHTML = people.length
    ? people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">Cadastre ${type === "receber" ? "um cliente" : "um fornecedor"} primeiro</option>`;
}

function createPersonFromTransactionDialog() {
  const type = els.transactionType.value === "receber" ? "cliente" : "fornecedor";
  const name = window.prompt(`Nome do novo ${type}:`, "");
  if (!name || !name.trim()) return;
  const person = {
    id: crypto.randomUUID(),
    type,
    name: name.trim(),
    document: "",
    contact: "",
  };
  state.people.push(person);
  persist();
  hydratePersonOptions();
  hydrateSalePeople();
  hydrateProjectOptions();
  hydrateInvoicePersonOptions();
  els.transactionPerson.value = person.id;
  toast(`${type === "cliente" ? "Cliente" : "Fornecedor"} criado e selecionado.`);
}

function createProjectFromTransactionDialog() {
  if (!guardViewAccess("projetos")) return;
  const suggested = els.transactionDescription.value || personName(els.transactionPerson.value);
  const name = window.prompt("Nome do novo projeto:", suggested);
  if (!name || !name.trim()) return;
  const amount = Number(els.transactionAmount.value || 0);
  const project = {
    id: crypto.randomUUID(),
    code: "",
    name: name.trim(),
    customerId: els.transactionType.value === "receber" ? els.transactionPerson.value : "",
    status: "ativo",
    startDate: todayIso,
    endDate: "",
    contractValue: els.transactionType.value === "receber" ? amount : 0,
    expectedCosts: els.transactionType.value === "pagar" ? amount : 0,
    targetMargin: 20,
    costCenterId: crypto.randomUUID(),
    notes: "Criado durante cadastro de lançamento financeiro.",
  };
  state.projects.push(project);
  upsertCostCenter(project);
  persist();
  hydrateProjectOptions();
  els.transactionProjectMode.value = "single";
  els.transactionProject.value = project.id;
  renderAllocationControls();
  renderProjects();
  renderProjectReports();
  toast("Projeto criado e selecionado.");
}

function updateTransactionInstallmentUi() {
  const isReceivable = els.transactionType.value === "receber";
  const enabled = isReceivable && els.transactionUseInstallments.checked;
  els.transactionInstallmentBox.classList.toggle("hidden", !isReceivable);
  els.transactionInstallments.disabled = !enabled;
  els.transactionInstallmentInterval.disabled = !enabled;
  els.transactionCustomDays.disabled = !enabled || els.transactionInstallmentInterval.value !== "custom";
  els.transactionCustomDaysWrap.classList.toggle("hidden", !enabled || els.transactionInstallmentInterval.value !== "custom");
  renderTransactionInstallmentPreview();
}

function renderTransactionInstallmentPreview() {
  if (!els.transactionUseInstallments.checked || els.transactionType.value !== "receber") {
    els.transactionInstallmentPreview.innerHTML = emptyMessage("Marque Gerar parcelas para dividir este recebível.");
    return;
  }
  const total = Number(els.transactionAmount.value || 0);
  const count = Number(els.transactionInstallments.value || 1);
  const firstDue = els.transactionDueDate.value;
  if (!total || !count || !firstDue) {
    els.transactionInstallmentPreview.innerHTML = emptyMessage("Informe valor, vencimento e quantidade para visualizar as parcelas.");
    return;
  }
  const installments = buildInstallments(total, count, firstDue, els.transactionInstallmentInterval.value, Number(els.transactionCustomDays.value));
  els.transactionInstallmentPreview.innerHTML = `
    <strong>Previsão das parcelas</strong>
    <div class="preview-grid">
      ${installments.map((item) => `<span>${item.number}/${count}</span><span>${formatDate(item.dueDate)}</span><strong>${money(item.amount)}</strong>`).join("")}
    </div>`;
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
  renderInvoiceReports(period);
}

function renderInvoiceReports(period) {
  const periodInvoices = state.invoices.filter((item) => isInPeriod(item.issueDate, period.start, period.end) && item.status !== "cancelada");
  const servico = periodInvoices.filter((item) => item.kind === "servico");
  const material = periodInvoices.filter((item) => item.kind === "material");
  const despesa = periodInvoices.filter((item) => item.kind === "despesa");

  renderInvoiceBillingReport(servico, material);
  renderInvoiceExpenseReport(despesa);
  renderExpenseNoInvoiceReport(period);
  renderPaidNoInvoiceReport(period);
  renderReceivableNoInvoiceReport(period);
  renderInvoiceByProjectReport(periodInvoices.filter((item) => item.kind !== "despesa"));
  renderInvoiceByClientReport(periodInvoices.filter((item) => item.kind !== "despesa"));
  renderInvoiceBySupplierReport(despesa);
  renderInvoiceDivergenceReport();
}

function renderInvoiceBillingReport(servico, material) {
  const servicoTotal = sum(servico.map(accountingValueOf));
  const materialTotal = sum(material.map(accountingValueOf));
  document.querySelector("#invoiceBillingReport").innerHTML = `
    <article class="report-item">
      <strong><span>NF de Serviço</span><span>${money(servicoTotal)}</span></strong>
      <span class="muted">${servico.length} nota(s) emitida(s) no período</span>
    </article>
    <article class="report-item">
      <strong><span>NF de Material/Produto</span><span>${money(materialTotal)}</span></strong>
      <span class="muted">${material.length} nota(s) emitida(s) no período</span>
    </article>
    <article class="report-item">
      <strong><span>Total geral faturado</span><span>${money(servicoTotal + materialTotal)}</span></strong>
      <span class="muted">${servico.length + material.length} nota(s) no total</span>
    </article>`;
}

function renderInvoiceExpenseReport(despesa) {
  const total = sum(despesa.map(accountingValueOf));
  document.querySelector("#invoiceExpenseReport").innerHTML = despesa.length
    ? `<article class="report-item">
        <strong><span>NF de despesa recebidas</span><span>${money(total)}</span></strong>
        <span class="muted">${despesa.length} nota(s) no período</span>
      </article>`
    : emptyMessage("Nenhuma NF de despesa recebida no período.");
}

function renderExpenseNoInvoiceReport(period) {
  const rows = state.transactions
    .filter((item) => item.type === "pagar" && !item.invoiceId && isInPeriod(item.dueDate, period.start, period.end))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  document.querySelector("#expenseNoInvoiceReport").innerHTML = rows.length
    ? rows.map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${statusLabel(item.status)}</span>
      </article>`).join("")
    : emptyMessage("Todas as despesas do período têm NF vinculada.");
}

function renderPaidNoInvoiceReport(period) {
  const rows = state.transactions
    .filter((item) => item.type === "pagar" && item.status === "pago" && !item.invoiceId && isInPeriod(item.paidDate, period.start, period.end))
    .sort((a, b) => a.paidDate.localeCompare(b.paidDate));
  document.querySelector("#paidNoInvoiceReport").innerHTML = rows.length
    ? rows.map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.paidDate)} · ${personName(item.personId)}</span>
      </article>`).join("")
    : emptyMessage("Nenhuma conta paga sem NF no período.");
}

function renderReceivableNoInvoiceReport(period) {
  const rows = state.transactions
    .filter((item) => item.type === "receber" && !item.invoiceId && isInPeriod(item.dueDate, period.start, period.end))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  document.querySelector("#receivableNoInvoiceReport").innerHTML = rows.length
    ? rows.map((item) => `
      <article class="report-item">
        <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
        <span class="muted">${formatDate(item.dueDate)} · ${personName(item.personId)} · ${statusLabel(item.status)}</span>
      </article>`).join("")
    : emptyMessage("Todas as contas a receber do período têm NF vinculada.");
}

function groupInvoicesBy(invoices, keyField, nameFn) {
  const map = new Map();
  invoices.forEach((item) => {
    const key = item[keyField] || "";
    const row = map.get(key) || { key, total: 0, count: 0 };
    row.total += accountingValueOf(item);
    row.count += 1;
    map.set(key, row);
  });
  return [...map.values()].sort((a, b) => b.total - a.total).map((row) => ({ ...row, name: nameFn(row.key) }));
}

function renderInvoiceByProjectReport(invoices) {
  const rows = groupInvoicesBy(invoices, "projectId", (key) => (key ? projectName(key) : "Sem projeto"));
  document.querySelector("#invoiceByProjectReport").innerHTML = rows.length
    ? rows.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
        <span class="muted">${row.count} NF</span>
      </article>`).join("")
    : emptyMessage("Sem dados para este relatório.");
}

function renderInvoiceByClientReport(invoices) {
  const rows = groupInvoicesBy(invoices, "personId", personName);
  document.querySelector("#invoiceByClientReport").innerHTML = rows.length
    ? rows.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
        <span class="muted">${row.count} NF</span>
      </article>`).join("")
    : emptyMessage("Sem dados para este relatório.");
}

function renderInvoiceBySupplierReport(despesa) {
  const rows = groupInvoicesBy(despesa, "personId", personName);
  document.querySelector("#invoiceBySupplierReport").innerHTML = rows.length
    ? rows.map((row) => `
      <article class="report-item">
        <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
        <span class="muted">${row.count} NF</span>
      </article>`).join("")
    : emptyMessage("Sem dados para este relatório.");
}

function renderInvoiceDivergenceReport() {
  const rows = state.invoices
    .filter((invoice) => invoice.status !== "cancelada")
    .map((invoice) => {
      const linked = linkedTransactionsForInvoice(invoice.id);
      const financialTotal = sum(linked);
      return { invoice, financialTotal, linkedCount: linked.length, diff: roundCurrency(invoice.accountingValue - financialTotal) };
    })
    .filter((row) => row.linkedCount > 0);

  document.querySelector("#invoiceDivergenceReport").innerHTML = rows.length
    ? rows.map((row) => `
      <tr class="invoice-divergence-row ${Math.abs(row.diff) > 0.01 ? "mismatch" : ""}">
        <td>NF ${escapeHtml(row.invoice.number)} · ${escapeHtml(personName(row.invoice.personId))}</td>
        <td>${row.linkedCount} parcela(s)</td>
        <td class="money">${money(row.invoice.accountingValue)}</td>
        <td class="money">${money(row.financialTotal)}</td>
        <td class="money">${money(row.diff)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">${emptyMessage("Nenhuma NF vinculada a lançamentos para comparar.")}</td></tr>`;
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
    state.crmUnits = data.crmUnits;
    state.crmPipelines = data.crmPipelines;
    state.opportunityStages = data.opportunityStages;
    state.opportunities = data.opportunities;
    state.opportunityHistory = data.opportunityHistory;
    state.projects = data.projects;
    state.costCenters = data.costCenters;
    state.bankAccounts = data.bankAccounts;
    state.bankMovements = data.bankMovements;
    state.transactions = data.transactions;
    state.invoices = data.invoices;
    state.stockItems = data.stockItems;
    state.stockMovements = data.stockMovements;
    state.stockLocations = data.stockLocations;
    state.installations = data.installations;
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
