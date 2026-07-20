const STORAGE_KEY = "financeiro-lumeris-v3";
const LEGACY_STORAGE_KEYS = ["financeiro-lumeris-v2", "financeiro-lumeris-v1"];

// URL de implantação do Google Apps Script (Web App). Preencha depois de publicar o Code.gs
// na sua planilha para que todos os usu?rios passem a compartilhar os mesmos dados.
const SHEETS_ENDPOINT = "https://script.google.com/macros/s/AKfycbw6UqQ8YH0jMLdvDfSumh6h8zZfBSh91NIOd6oqJo_DP5bgP88N8lLl25daHvwCUWSq/exec";
const SYNC_DEBOUNCE_MS = 800;
const SYNC_TIMEOUT_MS = 45000;
const FORCE_MAINTENANCE_MODE = false;
const FORCE_MAINTENANCE_MESSAGE = "Sistema em manutencao para ajustes. Por favor, aguarde a liberacao.";
let remoteUpdatedAt = "";
let syncTimer = null;
let syncInFlight = false;
let syncQueued = false;
let pendingSyncScopes = new Set();

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

// Um ?nico menu "Notas Fiscais" com 3 sub-abas (kind), em vez de 3 telas separadas ?
// evita triplicar formul?rio/lista/relatérios para dados que t?m a mesma forma.
const INVOICE_KIND_META = {
 servico: { label: "NF de Serviço emitida", direction: "emitida", personLabel: "Cliente", statusOptions: INVOICE_STATUS_OPTIONS_EMITIDA },
 material: { label: "NF de Material/Produto emitida", direction: "emitida", personLabel: "Cliente", statusOptions: INVOICE_STATUS_OPTIONS_EMITIDA },
 despesa: { label: "NF de despesa recebida", direction: "recebida", personLabel: "Fornecedor", statusOptions: INVOICE_STATUS_OPTIONS_DESPESA },
};

// Camada de integração banc?ria: cada provedor implementa fetchStatement(account, {start, end})
// e devolve movimentos no MESMO formato produzido por parseOfx, para reaproveitar dedupe/conciliação.
// "inter" e "santander" nunca chamam o banco direto do navegador (impossível: exigem mTLS/segredos que
// não podem existir num site est?tico) ? eles chamam um backend pr?prio que voc? hospeda e que guarda
// as credenciais reais. Enquanto esse backend não existir, use o provedor "mock".
// (Referencia funúes declaradas mais abaixo ? seguro porque function declarations s?o hoisted.)
const BANK_PROVIDERS = {
 mock: { label: "Simulado (dados de teste)", requiresEndpoint: false, fetchStatement: (account, range) => mockFetchStatement(account, range) },
 inter: { label: "Banco Inter (API real via backend)", requiresEndpoint: true, fetchStatement: (account, range) => fetchStatementViaBackend("inter", account, range) },
 santander: { label: "Santander (API real via backend)", requiresEndpoint: true, fetchStatement: (account, range) => fetchStatementViaBackend("santander", account, range) },
};

const MOCK_DESCRIPTIONS = {
 "077": {
  entrada: ["Pix recebido - Cliente Simulado", "Transfer?ncia recebida", "Rendimento de aplicação"],
  saida: ["Pix enviado - Fornecedor Simulado", "Pagamento de boleto", "Tarifa de manutenúo"],
 },
 "033": {
  entrada: ["TED recebida", "Dep?sito identificado", "Rendimento CDB"],
  saida: ["D?bito autom?tico", "Compra no d?bito", "Pagamento de conv?nio"],
 },
};

// Controle de acesso por papel. "administrador" (null) enxerga tudo; os demais pap?is
// s? acessam as views listadas aqui. Este ? o ?nico lugar que decide isso ? setView() e
// updateSessionUi() (menu) consultam a mesma funúo canAccessView(), ent?o não existe
// como uma tela ficar acess?vel por engano num lugar e bloqueada em outro.
const SECTOR_ALLOWED_VIEWS = {
 financeiro: ["dashboard", "receber", "pagar", "banco", "apisbancarias", "notasfiscais", "relatorios", "pessoas"],
 comercial: ["dashboard", "crm", "vendas"],
 vendas: ["dashboard", "crm", "vendas"],
 projetos: ["projetos", "protocolos", "instalacoes", "estoque"],
 instaladores: ["dashboard", "instalacoes"],
 engenharia: ["dashboard", "projetos", "protocolos", "instalacoes", "estoque"],
 diretoria: ["dashboard", "projetos", "protocolos", "instalacoes", "estoque", "crm", "vendas", "relatorios"],
};

const SAVE_SCOPE_FIELDS = {
 crm: ["crmUnits", "crmPipelines", "opportunityStages", "opportunities", "opportunityHistory", "sales", "sellers", "interactions", "tasks"],
 financeiro: ["transactions", "bankAccounts", "bankMovements", "bankApiConfigs", "invoices"],
 protocolo: ["protocols", "protocolHistory", "utilityCompanies", "protocolActivityTypes"],
 estoque: ["stockItems", "stockMovements", "stockLocations"],
 projetos: ["projects", "costCenters", "installations", "installationWorkers"],
 config: ["users", "maintenance"],
};

const SHARED_MERGE_FIELDS = ["people", "projects", "costCenters", "installations", "installationWorkers"];

const ROLE_LABELS = {
 administrador: "Administrador",
 estoque: "Estoque",
 usuario: "Usu?rio",
};

const SECTOR_LABELS = {
 financeiro: "Financeiro",
 comercial: "Comercial",
 vendas: "Vendas",
 projetos: "Projetos",
 instaladores: "Instaladores",
 engenharia: "Engenharia",
 diretoria: "Diretoria",
};

const DEFAULT_USER_SECTORS = Object.keys(SECTOR_ALLOWED_VIEWS);
let currentStockTab = "itens";
let bankApiAutoSyncRunning = false;

// Central de Protocolos: cadastro de concession?rias e tipos de atividade usa ids fixos
// nos itens padr?o (em vez de crypto.randomUUID()) para que PROTOCOL_CHECKLIST_TEMPLATES
// consiga referenciar o tipo de forma est?vel entre instalações diferentes do app.
const UTILITY_COMPANY_DEFAULTS = [
 { id: "cpfl_piratininga", name: "CPFL Piratininga" },
 { id: "cpfl_paulista", name: "CPFL Paulista" },
 { id: "cetril", name: "Cetril" },
 { id: "elektro", name: "Elektro" },
 { id: "seripa", name: "Seripa" },
 { id: "enel", name: "Enel" },
];

const PROTOCOL_ACTIVITY_TYPE_DEFAULTS = [
 { id: "consulta_viabilidade", name: "Consulta de viabilidade" },
 { id: "homologacao", name: "Homologação" },
 { id: "revisao_projeto", name: "Revis?o de projeto" },
 { id: "troca_medidor", name: "Troca de medidor" },
 { id: "troca_titularidade", name: "Troca de titularidade" },
 { id: "ligacao_nova", name: "Ligação nova" },
 { id: "aumento_carga", name: "Aumento de carga" },
 { id: "alteracao_demanda", name: "Alteração de demanda" },
 { id: "migracao_tarifaria", name: "Migração tarif?ria" },
 { id: "vistoria", name: "Vistoria" },
 { id: "pendencia_documental", name: "Pend?ncia documental" },
 { id: "analise_tecnica", name: "An?lise técnica" },
 { id: "outro", name: "Outro" },
];

// Cada item de checklist funciona tamb?m como controle de documento (status
// pendente/enviado/aprovado/rejeitado), evitando manter listas separadas de
// "documentos enviados"/"documentos pendentes" que duplicariam a mesma informação.
const PROTOCOL_CHECKLIST_TEMPLATES = {
 homologacao: ["ART", "Projeto el?trico", "Procuração", "Documento do cliente", "Conta de energia", "Memorial descritivo", "Formul?rios da concession?ria"],
};

const PROTOCOL_STATUSES = [
 { id: "novo", label: "Novo", tone: "neutral" },
 { id: "em_preparacao", label: "Em preparação", tone: "neutral" },
 { id: "protocolado", label: "Protocolado", tone: "warn" },
 { id: "em_analise", label: "Em an?lise", tone: "warn" },
 { id: "aguardando_documentos", label: "Aguardando documentos", tone: "warn" },
 { id: "aguardando_cliente", label: "Aguardando cliente", tone: "warn" },
 { id: "aguardando_concessionaria", label: "Aguardando concession?ria", tone: "warn" },
 { id: "pendencia_tecnica", label: "Pend?ncia técnica", tone: "danger" },
 { id: "projeto_aprovado", label: "Projeto aprovado", tone: "ok" },
 { id: "projeto_reprovado", label: "Projeto reprovado", tone: "danger" },
 { id: "instalacao_liberada", label: "Instalação liberada", tone: "ok" },
 { id: "concluido", label: "Concluído", tone: "ok" },
 { id: "cancelado", label: "Cancelado", tone: "danger" },
];

// Status que encerram o acompanhamento de prazo (não faz sentido mostrar "vencido"
// para um ticket já concluído, cancelado, reprovado ou liberado).
const PROTOCOL_CLOSED_STATUSES = ["projeto_reprovado", "instalacao_liberada", "concluido", "cancelado"];
const PROTOCOL_RELEASE_STATUS = "instalacao_liberada";
const PROJECT_STATUS_RELEASED_FOR_INSTALLATION = "liberado_instalacao";

const PROTOCOL_STALE_DAYS = 10;
const PROTOCOL_ALERT_CATEGORIES = [
 { key: "vencidos", label: "Vencidos", apply: () => { els.protocolFilterDeadline.value = "atraso"; } },
 { key: "venceHoje", label: "Prazo termina hoje", apply: () => { els.protocolFilterDeadline.value = "hoje"; } },
 { key: "venceAmanha", label: "Prazo termina amanh?", apply: () => { els.protocolFilterDeadline.value = "semana"; } },
 { key: "aguardandoCliente", label: "Cliente aguardando resposta", apply: () => { els.protocolFilterStatus.value = "aguardando_cliente"; } },
 { key: "aguardandoDocumentos", label: "Concession?ria aguardando documentos", apply: () => { els.protocolFilterStatus.value = "aguardando_documentos"; } },
 { key: "paradoHaMuitosDias", label: `Parado h? mais de ${PROTOCOL_STALE_DAYS} dias`, apply: () => {} },
];

const STOCK_UNIT_LABELS = {
 unidade: "Unidade",
 peca: "Pe?a",
 metro: "Metro",
 metro_quadrado: "Metro quadrado",
 metro_cubico: "Metro c?bico",
 quilo: "Quilo",
 litro: "Litro",
 caixa: "Caixa",
 pacote: "Pacote",
 rolo: "Rolo",
};

const STOCK_EXIT_TYPE_LABELS = {
 consumo_projeto: "Consumo em projeto",
 uso_interno: "Uso interno",
 transferencia: "Transfer?ncia",
 perda: "Perda",
 avaria: "Avaria",
 descarte: "Descarte",
 emprestimo: "Empr?stimo",
 outro: "Outro",
};

let currentCrmTab = "funil";
let currentCrmView = "kanban";
let pendingOpportunityConversion = null;
let pendingWonOpportunity = null;
let technicalReportDraftPhotos = [];
let opportunityAttachmentsDraft = [];
let driveAutomationCapability = null;
let showLostOpportunities = false;

// Ordem do funil ? usada tanto para renderizar as colunas quanto para calcular
// taxa de convers?o por est?gio nos relatérios. "ganho"/"perdido" s?o est?gios
// terminais (não t?m "pr?ximo est?gio" para fins de convers?o sequencial).
const OPPORTUNITY_STAGES = [
 { key: "prospeccao", label: "Prospecúo" },
 { key: "contato", label: "Contato" },
 { key: "proposta", label: "Proposta" },
 { key: "negociacao", label: "Negociação" },
 { key: "ganho", label: "Ganho" },
 { key: "perdido", label: "Perdido" },
];

const INSTALLATION_BACKLOG_SEED = [
 { code: "IEV 0183-05-26", client: "Suzy Yamamoto", date: "02062026", note: "PG" },
 { code: "IEV 0205-06-26", client: "Nilton Bastos", date: "22062026", note: "Falta 25%" },
 { code: "IEV 0200-06-26", client: "Ar Global Com\u00e9rcio de Equipamentos LTDA (Rosita)", date: "12062026", note: "Falta 100%" },
 { code: "IEV 0195-06-26", client: "Rosita Fragoso", date: "12062026", note: "Falta 100%" },
 { code: "IEV 0190-05-26", client: "Francisco Mazon Junior", date: "31052026", note: "PG" },
 { code: "IEV 0185-05-26", client: "Uderlei Dias", date: "29052026", note: "PG" },
 { code: "IEV 0125-02-26", client: "Bruno Rede Bom Lugar", date: "07042026", note: "PG" },
 { code: "IEV 0056-01-26", client: "Peterson - A\u00e7ougue", date: "20032026", note: "Falta 95%" },
 { code: "IE 1255-07-26", client: "Karoline Alves Diniz", date: "16072026", note: "Falta 100%" },
 { code: "IE 1240-06-26", client: "Elisangela Teixeira", date: "23062026", note: "PG" },
 { code: "IE 1198-04-26", client: "Danilo Vinicius Luiz Tasso Da Costa", date: "06072026", note: "Falta 40%" },
 { code: "IE 1186-03-26", client: "Marcos Yoshinori Sugimoto", date: "04052026", note: "Falta 58%" },
 { code: "IE 1164-02-26", client: "F\u00e1bio M\u00e1rcio De Oliveira", date: "27022026", note: "PG", serviceType: "ampliacao" },
 { code: "IE 1153-01-26", client: "Bruno Fernando Ribeiro Martins R5", date: "30042026", note: "Falta 83%" },
 { code: "IE 1152-01-26", client: "Leandro Ferreira Da Silva (Avar\u00e9)", date: "30012026", note: "Falta 100%" },
];

const INTERACTION_TYPE_LABELS = {
 ligacao: "Ligação",
 email: "E-mail",
 reuniao: "Reuni?o",
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
 maintenanceScreen: document.querySelector("#maintenanceScreen"),
 maintenanceMessage: document.querySelector("#maintenanceMessage"),
 maintenanceLogoutBtn: document.querySelector("#maintenanceLogoutBtn"),
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
 userSectorFields: Array.from(document.querySelectorAll("[data-user-sector]")),
 userActive: document.querySelector("#userActive"),
 usersList: document.querySelector("#usersList"),
 invoiceForm: document.querySelector("#invoiceForm"),
 invoiceFormTitle: document.querySelector("#invoiceFormTitle"),
 invoiceId: document.querySelector("#invoiceId"),
 invoiceKind: document.querySelector("#invoiceKind"),
 invoiceXmlFile: document.querySelector("#invoiceXmlFile"),
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
 invoiceLinkProject: document.querySelector("#invoiceLinkProject"),
 invoiceLinkList: document.querySelector("#invoiceLinkList"),
 bankMatchInvoice: document.querySelector("#bankMatchInvoice"),
 stockAlertBelowMin: document.querySelector("#stockAlertBelowMin"),
 stockAlertZero: document.querySelector("#stockAlertZero"),
 stockAlertAboveMax: document.querySelector("#stockAlertAboveMax"),
 stockItemForm: document.querySelector("#stockItemForm"),
 stockItemFormTitle: document.querySelector("#stockItemFormTitle"),
 stockItemId: document.querySelector("#stockItemId"),
 cancelStockItemEditBtn: document.querySelector("#cancelStockItemEditBtn"),
 saveStockItemBtn: document.querySelector("#saveStockItemBtn"),
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
 stockItemCount: document.querySelector("#stockItemCount"),
 stockItemTable: document.querySelector("#stockItemTable"),
 importIluminarStockBtn: document.querySelector("#importIluminarStockBtn"),
 stockTotalValue: document.querySelector("#stockTotalValue"),
 stockPurchaseCount: document.querySelector("#stockPurchaseCount"),
 stockMonthEntryTotal: document.querySelector("#stockMonthEntryTotal"),
 stockMonthExitTotal: document.querySelector("#stockMonthExitTotal"),
 stockMonthResultTotal: document.querySelector("#stockMonthResultTotal"),
 stockFilterStart: document.querySelector("#stockFilterStart"),
 stockFilterEnd: document.querySelector("#stockFilterEnd"),
 stockFilterType: document.querySelector("#stockFilterType"),
 stockFilterProject: document.querySelector("#stockFilterProject"),
 stockFilterItem: document.querySelector("#stockFilterItem"),
 stockFilterStatus: document.querySelector("#stockFilterStatus"),
 stockFilterCategory: document.querySelector("#stockFilterCategory"),
 applyStockFilters: document.querySelector("#applyStockFilters"),
 clearStockFilters: document.querySelector("#clearStockFilters"),
 stockEntryForm: document.querySelector("#stockEntryForm"),
 stockEntryDate: document.querySelector("#stockEntryDate"),
 stockEntrySupplier: document.querySelector("#stockEntrySupplier"),
 newStockEntrySupplierBtn: document.querySelector("#newStockEntrySupplierBtn"),
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
 newStockExitProjectBtn: document.querySelector("#newStockExitProjectBtn"),
 stockExitRecipient: document.querySelector("#stockExitRecipient"),
 stockExitReason: document.querySelector("#stockExitReason"),
 stockExitNotes: document.querySelector("#stockExitNotes"),
 stockExitList: document.querySelector("#stockExitList"),
 stockMovementDialog: document.querySelector("#stockMovementDialog"),
 stockMovementTitle: document.querySelector("#stockMovementTitle"),
 stockMovementDetails: document.querySelector("#stockMovementDetails"),
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
 opportunityWonClosedDate: document.querySelector("#opportunityWonClosedDate"),
 opportunityWonServiceType: document.querySelector("#opportunityWonServiceType"),
 opportunityWonCreateProject: document.querySelector("#opportunityWonCreateProject"),
 crmKanbanMetrics: document.querySelector("#crmKanbanMetrics"),
 crmLeadListTable: document.querySelector("#crmLeadListTable"),
 crmLeadListSummary: document.querySelector("#crmLeadListSummary"),
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
 openSalesRankMonthTvBtn: document.querySelector("#openSalesRankMonthTvBtn"),
 openSalesRankYearTvBtn: document.querySelector("#openSalesRankYearTvBtn"),
 toggleLostOpportunitiesBtn: document.querySelector("#toggleLostOpportunitiesBtn"),
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
 crmCloseStart: document.querySelector("#crmCloseStart"),
 crmCloseEnd: document.querySelector("#crmCloseEnd"),
 crmPendingOnly: document.querySelector("#crmPendingOnly"),
 crmStaleOnly: document.querySelector("#crmStaleOnly"),
 kanbanBoard: document.querySelector("#kanbanBoard"),
 opportunityDialog: document.querySelector("#opportunityDialog"),
 opportunityForm: document.querySelector("#opportunityForm"),
 opportunityTitle: document.querySelector("#opportunityTitle"),
 opportunityId: document.querySelector("#opportunityId"),
 opportunityPerson: document.querySelector("#opportunityPerson"),
 newOpportunityPersonBtn: document.querySelector("#newOpportunityPersonBtn"),
 opportunityCompany: document.querySelector("#opportunityCompany"),
 opportunityNumber: document.querySelector("#opportunityNumber"),
 opportunityValue: document.querySelector("#opportunityValue"),
 opportunityUnit: document.querySelector("#opportunityUnit"),
 opportunityPipeline: document.querySelector("#opportunityPipeline"),
 opportunityStage: document.querySelector("#opportunityStage"),
 opportunityClosedDate: document.querySelector("#opportunityClosedDate"),
 opportunityOwner: document.querySelector("#opportunityOwner"),
 opportunityPhone: document.querySelector("#opportunityPhone"),
 opportunityEmail: document.querySelector("#opportunityEmail"),
 opportunityProject: document.querySelector("#opportunityProject"),
 opportunityTags: document.querySelector("#opportunityTags"),
 opportunityNextActivity: document.querySelector("#opportunityNextActivity"),
 opportunityPendingActivity: document.querySelector("#opportunityPendingActivity"),
 opportunityNotes: document.querySelector("#opportunityNotes"),
 opportunityAddress: document.querySelector("#opportunityAddress"),
 opportunityLatitude: document.querySelector("#opportunityLatitude"),
 opportunityLongitude: document.querySelector("#opportunityLongitude"),
 opportunityDriveFolder: document.querySelector("#opportunityDriveFolder"),
 opportunityFileInput: document.querySelector("#opportunityFileInput"),
 opportunityAttachmentDropzone: document.querySelector("#opportunityAttachmentDropzone"),
 opportunityAttachmentStatus: document.querySelector("#opportunityAttachmentStatus"),
 opportunityAttachmentRows: document.querySelector("#opportunityAttachmentRows"),
 addOpportunityAttachmentBtn: document.querySelector("#addOpportunityAttachmentBtn"),
 createOpportunityDriveFolderBtn: document.querySelector("#createOpportunityDriveFolderBtn"),
 pickOpportunityFilesBtn: document.querySelector("#pickOpportunityFilesBtn"),
 openOpportunityMapBtn: document.querySelector("#openOpportunityMapBtn"),
 crmMapBtn: document.querySelector("#crmMapBtn"),
 crmMapDialog: document.querySelector("#crmMapDialog"),
 crmMapList: document.querySelector("#crmMapList"),
 openCrmRouteBtn: document.querySelector("#openCrmRouteBtn"),
 proposalConsumption: document.querySelector("#proposalConsumption"),
 proposalGeneration: document.querySelector("#proposalGeneration"),
 proposalMonthlyRows: document.querySelector("#proposalMonthlyRows"),
 proposalPower: document.querySelector("#proposalPower"),
 proposalModuleQuantity: document.querySelector("#proposalModuleQuantity"),
 proposalInverterType: document.querySelector("#proposalInverterType"),
 proposalInverterBrand: document.querySelector("#proposalInverterBrand"),
 proposalInverterQuantity: document.querySelector("#proposalInverterQuantity"),
 proposalModuleBrand: document.querySelector("#proposalModuleBrand"),
 proposalModulePower: document.querySelector("#proposalModulePower"),
 proposalRoofType: document.querySelector("#proposalRoofType"),
 proposalBattery: document.querySelector("#proposalBattery"),
 proposalTariff: document.querySelector("#proposalTariff"),
 proposalPaymentTerms: document.querySelector("#proposalPaymentTerms"),
 proposalDeliveryDeadline: document.querySelector("#proposalDeliveryDeadline"),
 proposalInvestment: document.querySelector("#proposalInvestment"),
 proposalKitProvider: document.querySelector("#proposalKitProvider"),
 proposalKitValue: document.querySelector("#proposalKitValue"),
 proposalDistanceKm: document.querySelector("#proposalDistanceKm"),
 proposalLaborPerPanel: document.querySelector("#proposalLaborPerPanel"),
 proposalInstallMaterialCost: document.querySelector("#proposalInstallMaterialCost"),
 proposalExtraCost: document.querySelector("#proposalExtraCost"),
 proposalTaxPercent: document.querySelector("#proposalTaxPercent"),
 proposalCommissionPercent: document.querySelector("#proposalCommissionPercent"),
 proposalTargetMarginPercent: document.querySelector("#proposalTargetMarginPercent"),
 proposalPriceAdjustmentPercent: document.querySelector("#proposalPriceAdjustmentPercent"),
 proposalPricingResult: document.querySelector("#proposalPricingResult"),
 proposalAcceptanceData: document.querySelector("#proposalAcceptanceData"),
 proposalNotes: document.querySelector("#proposalNotes"),
 generateOpportunityProposalBtn: document.querySelector("#generateOpportunityProposalBtn"),
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
 newTransactionProjectFieldBtn: document.querySelector("#newTransactionProjectFieldBtn"),
 transactionProjectWrap: document.querySelector("#transactionProjectWrap"),
 transactionDirectProjectCost: document.querySelector("#transactionDirectProjectCost"),
 allocationBox: document.querySelector("#allocationBox"),
 allocationRows: document.querySelector("#allocationRows"),
 allocationTotal: document.querySelector("#allocationTotal"),
 transactionInstallmentBox: document.querySelector("#transactionInstallmentBox"),
 transactionUseInstallments: document.querySelector("#transactionUseInstallments"),
 transactionEntryAmount: document.querySelector("#transactionEntryAmount"),
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
 bankAccountFilter: document.querySelector("#bankAccountFilter"),
 bankDateStart: document.querySelector("#bankDateStart"),
 bankDateEnd: document.querySelector("#bankDateEnd"),
 bankMonthFilter: document.querySelector("#bankMonthFilter"),
 bankYearFilter: document.querySelector("#bankYearFilter"),
 bankDialog: document.querySelector("#bankDialog"),
 bankForm: document.querySelector("#bankForm"),
 bankMovementId: document.querySelector("#bankMovementId"),
 bankMovementSummary: document.querySelector("#bankMovementSummary"),
 bankCategory: document.querySelector("#bankCategory"),
 bankDreGroup: document.querySelector("#bankDreGroup"),
 bankProject: document.querySelector("#bankProject"),
 newBankProjectBtn: document.querySelector("#newBankProjectBtn"),
 addBankAllocationBtn: document.querySelector("#addBankAllocationBtn"),
 bankAllocationRows: document.querySelector("#bankAllocationRows"),
 bankAllocationTotal: document.querySelector("#bankAllocationTotal"),
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
 bankApiForm: document.querySelector("#bankApiForm"),
 bankApiConfigId: document.querySelector("#bankApiConfigId"),
 bankApiProvider: document.querySelector("#bankApiProvider"),
 bankApiAccount: document.querySelector("#bankApiAccount"),
 bankApiEndpoint: document.querySelector("#bankApiEndpoint"),
 bankApiLookbackDays: document.querySelector("#bankApiLookbackDays"),
 bankApiAutoDaily: document.querySelector("#bankApiAutoDaily"),
 bankApiActive: document.querySelector("#bankApiActive"),
 bankApiNotes: document.querySelector("#bankApiNotes"),
 syncBankApiNowBtn: document.querySelector("#syncBankApiNowBtn"),
 bankApiConfigList: document.querySelector("#bankApiConfigList"),
 projectForm: document.querySelector("#projectForm"),
 projectId: document.querySelector("#projectId"),
 projectName: document.querySelector("#projectName"),
 projectCustomer: document.querySelector("#projectCustomer"),
 newProjectCustomerBtn: document.querySelector("#newProjectCustomerBtn"),
 projectStatus: document.querySelector("#projectStatus"),
 projectStartDate: document.querySelector("#projectStartDate"),
 projectEndDate: document.querySelector("#projectEndDate"),
 projectContractValue: document.querySelector("#projectContractValue"),
 projectExpectedCosts: document.querySelector("#projectExpectedCosts"),
 projectTargetMargin: document.querySelector("#projectTargetMargin"),
 projectNotes: document.querySelector("#projectNotes"),
 quickProjectDialog: document.querySelector("#quickProjectDialog"),
 quickProjectForm: document.querySelector("#quickProjectForm"),
 quickProjectName: document.querySelector("#quickProjectName"),
 quickProjectCustomer: document.querySelector("#quickProjectCustomer"),
 newQuickProjectCustomerBtn: document.querySelector("#newQuickProjectCustomerBtn"),
 quickProjectStatus: document.querySelector("#quickProjectStatus"),
 quickProjectStartDate: document.querySelector("#quickProjectStartDate"),
 quickProjectEndDate: document.querySelector("#quickProjectEndDate"),
 quickProjectContractValue: document.querySelector("#quickProjectContractValue"),
 quickProjectExpectedCosts: document.querySelector("#quickProjectExpectedCosts"),
 quickProjectTargetMargin: document.querySelector("#quickProjectTargetMargin"),
 quickProjectNotes: document.querySelector("#quickProjectNotes"),
 projectReportSelect: document.querySelector("#projectReportSelect"),
 protocolsTable: document.querySelector("#protocolsTable"),
 protocolSearch: document.querySelector("#protocolSearch"),
 protocolFilterUtility: document.querySelector("#protocolFilterUtility"),
 protocolFilterActivityType: document.querySelector("#protocolFilterActivityType"),
 protocolFilterStatus: document.querySelector("#protocolFilterStatus"),
 protocolFilterResponsible: document.querySelector("#protocolFilterResponsible"),
 protocolFilterCity: document.querySelector("#protocolFilterCity"),
 protocolFilterProject: document.querySelector("#protocolFilterProject"),
 protocolFilterDeadline: document.querySelector("#protocolFilterDeadline"),
 protocolFilterPriority: document.querySelector("#protocolFilterPriority"),
 protocolFilterPeriod: document.querySelector("#protocolFilterPeriod"),
 protocolDialog: document.querySelector("#protocolDialog"),
 protocolForm: document.querySelector("#protocolForm"),
 protocolDialogTitle: document.querySelector("#protocolDialogTitle"),
 protocolId: document.querySelector("#protocolId"),
 protocolInternalNumber: document.querySelector("#protocolInternalNumber"),
 protocolNumber: document.querySelector("#protocolNumber"),
 protocolActivityType: document.querySelector("#protocolActivityType"),
 protocolUtility: document.querySelector("#protocolUtility"),
 protocolCustomer: document.querySelector("#protocolCustomer"),
 newProtocolCustomerBtn: document.querySelector("#newProtocolCustomerBtn"),
 protocolCity: document.querySelector("#protocolCity"),
 protocolConsumerUnit: document.querySelector("#protocolConsumerUnit"),
 protocolProject: document.querySelector("#protocolProject"),
 protocolStatus: document.querySelector("#protocolStatus"),
 protocolResponsible: document.querySelector("#protocolResponsible"),
 protocolOpenedAt: document.querySelector("#protocolOpenedAt"),
 protocolDeadline: document.querySelector("#protocolDeadline"),
 protocolExpectedDate: document.querySelector("#protocolExpectedDate"),
 protocolPriority: document.querySelector("#protocolPriority"),
 protocolNotes: document.querySelector("#protocolNotes"),
 protocolDrawerContent: document.querySelector("#protocolDrawerContent"),
 protocolSettingsDialog: document.querySelector("#protocolSettingsDialog"),
 utilityCompanyList: document.querySelector("#utilityCompanyList"),
 utilityCompanyNameInput: document.querySelector("#utilityCompanyNameInput"),
 addUtilityCompanyBtn: document.querySelector("#addUtilityCompanyBtn"),
 activityTypeList: document.querySelector("#activityTypeList"),
 activityTypeNameInput: document.querySelector("#activityTypeNameInput"),
 addActivityTypeBtn: document.querySelector("#addActivityTypeBtn"),
 installationForm: document.querySelector("#installationForm"),
 installationId: document.querySelector("#installationId"),
 installationProject: document.querySelector("#installationProject"),
 installationCustomer: document.querySelector("#installationCustomer"),
 installationServiceType: document.querySelector("#installationServiceType"),
 installationStatus: document.querySelector("#installationStatus"),
 installationClosedDate: document.querySelector("#installationClosedDate"),
 installationPostSaleDueDate: document.querySelector("#installationPostSaleDueDate"),
 installationPostSaleContactedAt: document.querySelector("#installationPostSaleContactedAt"),
 installationDeadlineDate: document.querySelector("#installationDeadlineDate"),
 installationScheduledDate: document.querySelector("#installationScheduledDate"),
 installationCompletedDate: document.querySelector("#installationCompletedDate"),
 installationPanels: document.querySelector("#installationPanels"),
 installationOutsourcingCost: document.querySelector("#installationOutsourcingCost"),
 installationTeam: document.querySelector("#installationTeam"),
 installationWorkerName: document.querySelector("#installationWorkerName"),
 installationWorkerRole: document.querySelector("#installationWorkerRole"),
 installationWorkerDailyRate: document.querySelector("#installationWorkerDailyRate"),
 addInstallationWorkerBtn: document.querySelector("#addInstallationWorkerBtn"),
 installationWorkerList: document.querySelector("#installationWorkerList"),
 installationLaborRows: document.querySelector("#installationLaborRows"),
 installationEfficiencyPreview: document.querySelector("#installationEfficiencyPreview"),
 installationMaterials: document.querySelector("#installationMaterials"),
 installationNotes: document.querySelector("#installationNotes"),
 installationConclusion: document.querySelector("#installationConclusion"),
 technicalWarrantyStart: document.querySelector("#technicalWarrantyStart"),
 technicalTechnician: document.querySelector("#technicalTechnician"),
 technicalWhatsapp: document.querySelector("#technicalWhatsapp"),
 technicalEmail: document.querySelector("#technicalEmail"),
 technicalSummary: document.querySelector("#technicalSummary"),
 technicalPhotoGrid: document.querySelector("#technicalPhotoGrid"),
 fillSampleTechnicalReportBtn: document.querySelector("#fillSampleTechnicalReportBtn"),
 generateTechnicalReportBtn: document.querySelector("#generateTechnicalReportBtn"),
 deleteInstallationBtn: document.querySelector("#deleteInstallationBtn"),
 installationKpis: document.querySelector("#installationKpis"),
 installationDateStart: document.querySelector("#installationDateStart"),
 installationDateEnd: document.querySelector("#installationDateEnd"),
 installationTypeFilter: document.querySelector("#installationTypeFilter"),
 installationStatusFilter: document.querySelector("#installationStatusFilter"),
 resetInstallationFilters: document.querySelector("#resetInstallationFilters"),
 toggleInstallationFormBtn: document.querySelector("#toggleInstallationFormBtn"),
 installationSearch: document.querySelector("#installationSearch"),
 installationList: document.querySelector("#installationList"),
 installationListSummary: document.querySelector("#installationListSummary"),
 personForm: document.querySelector("#personForm"),
 personId: document.querySelector("#personId"),
 personType: document.querySelector("#personType"),
 personName: document.querySelector("#personName"),
 personDocument: document.querySelector("#personDocument"),
 personContact: document.querySelector("#personContact"),
 quickPersonDialog: document.querySelector("#quickPersonDialog"),
 quickPersonForm: document.querySelector("#quickPersonForm"),
 quickPersonType: document.querySelector("#quickPersonType"),
 quickPersonName: document.querySelector("#quickPersonName"),
 quickPersonDocument: document.querySelector("#quickPersonDocument"),
 quickPersonContact: document.querySelector("#quickPersonContact"),
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
 protocolos: "Central de Protocolos",
 instalacoes: "Instalações",
 banco: "Conciliação banc?ria",
 apisbancarias: "APIs banc?rias",
 notasfiscais: "Notas Fiscais",
 estoque: "Estoque",
 crm: "CRM",
 pessoas: "Clientes e fornecedores",
 relatorios: "Relatérios financeiros",
 usuarios: "Usu?rios",
};

function getDefaultCrmStages() {
 return [
 { id: "triagem", name: "Triagem", color: "#3f6f8f", order: 1 },
 { id: "contato", name: "Destinados / Contato Inicial", color: "#5d7f3f", order: 2 },
 { id: "diagnostico", name: "Diagn?stico", color: "#a06418", order: 3 },
 { id: "proposta", name: "Proposta", color: "#146c5f", order: 4 },
 { id: "negociacao", name: "Negociação", color: "#8757a2", order: 5 },
 { id: "ganho", name: "Fechado - Ganho", color: "#25744f", order: 6 },
 { id: "perdido", name: "Fechado - Perdido", color: "#aa2f2f", order: 7 },
 ];
}

const dreGroups = [
 { key: "receita_bruta", label: "Receita bruta", sign: 1 },
 { key: "deducoes", label: "Deduúes", sign: -1 },
 { key: "custos", label: "Custo direto", sign: -1 },
 { key: "despesas_operacionais", label: "Despesas operacionais", sign: -1 },
 { key: "despesas_financeiras", label: "Despesas financeiras", sign: -1 },
 { key: "impostos", label: "Impostos", sign: -1 },
 { key: "transitoria", label: "Transit?ria", sign: 0 },
 { key: "retirada", label: "Retirada", sign: -1 },
 { key: "outros", label: "Outros", sign: 1 },
];

let quickPersonTarget = "transaction";
let quickProjectTarget = "transaction";
let stockAutoImportRunning = false;

boot().catch((error) => {
 console.error("Falha ao iniciar o sistema:", error);
 els.loginError.textContent = "Erro ao carregar o sistema. Atualize a p?gina e tente novamente.";
 els.loginSubmit.disabled = false;
 els.loginSubmit.textContent = "Entrar";
});

async function boot() {
 try {
  bindEvents();
  setDefaultReportPeriod();
  renderAll();
  if (isSalesRankingTvMode()) {
   await initRemoteSync();
   renderSalesRankingTvMode();
   window.setInterval(renderSalesRankingTvMode, 60000);
   return;
  }
  await ensureMasterUser({ save: false });
  renderUsers();
  restoreSessionOrShowLogin();
  initRemoteSync()
   .then(async () => {
    await ensureMasterUser({ save: false });
    renderUsers();
    if (!currentSessionUser()) {
     restoreSessionOrShowLogin();
    }
   })
   .catch((error) => {
    console.error(error);
    setSyncStatus("Sem conex?o com o Sheets - usando dados locais", "error");
   });
 } finally {
  els.loginSubmit.disabled = false;
  els.loginSubmit.textContent = "Entrar";
 }
}

function ensureQuickProjectCustomerButton() {
 if (els.newQuickProjectCustomerBtn || !els.quickProjectCustomer) return;
 const wrapper = els.quickProjectCustomer.closest(".inline-control") || els.quickProjectCustomer.parentElement;
 if (!wrapper) return;
 const button = document.createElement("button");
 button.className = "secondary-btn";
 button.id = "newQuickProjectCustomerBtn";
 button.type = "button";
 button.textContent = "Novo cliente";
 wrapper.appendChild(button);
 els.newQuickProjectCustomerBtn = button;
}

function bindEvents() {
 ensureQuickProjectCustomerButton();
 els.loginForm.addEventListener("submit", handleLogin);
 els.logoutBtn.addEventListener("click", handleLogout);
 els.maintenanceLogoutBtn.addEventListener("click", handleLogout);
 els.userForm.addEventListener("submit", saveUser);
 els.userRole.addEventListener("change", updateUserSectorUi);
 enhanceSearchableSelect(els.projectCustomer, { placeholder: "Buscar cliente?" });
 enhanceSearchableSelect(els.bankProject, { placeholder: "Buscar projeto?" });

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
 els.invoiceXmlFile.addEventListener("change", importInvoiceXml);
 els.invoiceLinkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
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
 els.cancelStockItemEditBtn.addEventListener("click", resetStockItemForm);
 els.stockItemSearch.addEventListener("input", renderStockItems);
 els.importIluminarStockBtn.addEventListener("click", importIluminarStock);
 [els.stockFilterStart, els.stockFilterEnd, els.stockFilterType, els.stockFilterProject, els.stockFilterItem, els.stockFilterStatus, els.stockFilterCategory].forEach((field) => {
  field.addEventListener("input", renderStock);
 });
 els.applyStockFilters.addEventListener("click", renderStock);
 els.clearStockFilters.addEventListener("click", clearStockFilters);
 document.querySelectorAll("[data-stock-status-filter]").forEach((card) => {
  const applyCardFilter = () => applyStockStatusFilter(card.dataset.stockStatusFilter);
  card.addEventListener("click", applyCardFilter);
  card.addEventListener("keydown", (event) => {
   if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    applyCardFilter();
   }
  });
 });
 els.stockEntryForm.addEventListener("submit", saveStockEntry);
 els.newStockEntrySupplierBtn.addEventListener("click", createSupplierFromStockEntryDialog);
 els.stockEntryQuantity.addEventListener("input", updateStockEntryTotalCost);
 els.stockEntryUnitCost.addEventListener("input", updateStockEntryTotalCost);
 els.stockExitForm.addEventListener("submit", saveStockExit);
 els.stockExitType.addEventListener("change", updateStockExitTypeUi);
 els.newStockExitProjectBtn.addEventListener("click", createProjectFromStockExitDialog);
 enhanceSearchableSelect(els.stockEntryItem, { placeholder: "Buscar item?" });
 enhanceSearchableSelect(els.stockExitItem, { placeholder: "Buscar item?" });
 enhanceSearchableSelect(els.stockEntryProject, { placeholder: "Buscar projeto?" });
 enhanceSearchableSelect(els.stockExitProject, { placeholder: "Buscar projeto?" });
 enhanceSearchableSelect(els.stockFilterProject, { placeholder: "Todos os projetos" });
 enhanceSearchableSelect(els.stockFilterItem, { placeholder: "Todos os itens" });
 els.stockEntryDate.value = todayIso;
 els.stockExitDate.value = todayIso;
 els.stockFilterStart.value = currentMonthStart;
 els.stockFilterEnd.value = currentMonthEnd;
 updateStockExitTypeUi();

 document.querySelectorAll("[data-crm-tab]").forEach((button) => {
  button.addEventListener("click", () => setCrmTab(button.dataset.crmTab));
 });
 document.querySelector("#newOpportunityBtn").addEventListener("click", () => openOpportunityDialog(null));
 document.querySelector("#manageSellersBtn").addEventListener("click", openSellerDialog);
 document.querySelector("#newTaskBtn").addEventListener("click", openTaskDialog);

 els.opportunityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.opportunityDialog.close();
   return;
  }
  saveOpportunity();
 });

 els.sellerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.sellerDialog.close();
   return;
  }
  addSeller();
 });

 els.interactionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.interactionDialog.close();
   return;
  }
  saveInteraction();
 });

 els.taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.taskDialog.close();
   return;
  }
  saveTask();
 });
 els.taskSellerFilter.addEventListener("change", renderTasks);
 els.taskStatusFilter.addEventListener("change", renderTasks);

 els.opportunityLostForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.opportunityLostDialog.close();
   renderPipelineBoard(); // reverte o <select> que o usu?rio mudou visualmente, j? que nada foi salvo
   return;
  }
  confirmOpportunityLost();
 });

 els.opportunityWonForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const opportunity = pendingWonOpportunity;
  const wonSettings = opportunityWonSettingsFromDialog();
  pendingWonOpportunity = null;
  els.opportunityWonDialog.close();
  if (!opportunity || event.submitter.value === "cancel") return;
  applyOpportunityWonSettings(opportunity, wonSettings);
  if (event.submitter.value === "sale") convertOpportunityToSale(opportunity);
  if (event.submitter.value === "project") convertOpportunityToProject(opportunity);
  if (event.submitter.value === "installation") createInstallationFromWonOpportunity(opportunity, wonSettings);
  if (event.submitter.value === "contract") generateContractFromOpportunity(opportunity, wonSettings);
 });

 els.opportunityWonServiceType.addEventListener("change", syncOpportunityWonProjectChoice);

 // Ganchos para vincular a oportunidade de volta ? venda/projeto gerado, sem alterar
 // saveSale()/saveProject() ? eles rodam DEPOIS dos handlers originais (mesma ordem de
 // registro), ent?o checam o resultado real (o que foi de fato criado) em vez de assumir.
 els.saleDialog.addEventListener("close", () => {
  if (pendingOpportunityConversion.kind === "sale") {
   const created = state.sales.length > pendingOpportunityConversion.saleCountBefore;
   pendingOpportunityConversion = null;
   if (created) toast("Venda gerada a partir da oportunidade.");
  }
 });

 els.projectForm.addEventListener("submit", () => {
  if (pendingOpportunityConversion.kind === "project") {
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
 els.openSalesRankMonthTvBtn.addEventListener("click", () => openSalesRankingTv("month"));
 els.openSalesRankYearTvBtn.addEventListener("click", () => openSalesRankingTv("year"));
 els.toggleLostOpportunitiesBtn.addEventListener("click", () => {
  showLostOpportunities = !showLostOpportunities;
  renderPipelineBoard();
 });
 document.querySelectorAll("[data-crm-view]").forEach((button) => {
  button.addEventListener("click", () => setCrmView(button.dataset.crmView));
 });
 updateCrmReportPeriodUi();

 els.navItems.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
 document.querySelector("#newTransactionBtn").addEventListener("click", () => openTransactionDialog());
 document.querySelector("#newSaleBtn").addEventListener("click", openSaleDialog);
 document.querySelector("#newSaleInlineBtn").addEventListener("click", openSaleDialog);
 document.querySelector("#newOpportunityBtn").addEventListener("click", () => openOpportunityDialog());
 document.querySelector("#clearCrmFilters").addEventListener("click", clearCrmFilters);
 els.addOpportunityAttachmentBtn.addEventListener("click", () => addOpportunityAttachmentRow());
 els.opportunityAttachmentRows.addEventListener("click", handleOpportunityAttachmentAction);
 els.createOpportunityDriveFolderBtn.addEventListener("click", createOpportunityDriveFolderForCurrentLead);
 els.pickOpportunityFilesBtn.addEventListener("click", () => els.opportunityFileInput.click());
 els.opportunityFileInput.addEventListener("change", (event) => handleOpportunityFiles(event.target.files));
 els.opportunityAttachmentDropzone.addEventListener("dragover", handleOpportunityAttachmentDragOver);
 els.opportunityAttachmentDropzone.addEventListener("dragleave", handleOpportunityAttachmentDragLeave);
 els.opportunityAttachmentDropzone.addEventListener("drop", handleOpportunityAttachmentDrop);
 els.opportunityAttachmentDropzone.addEventListener("paste", handleOpportunityAttachmentPaste);
 els.generateOpportunityProposalBtn.addEventListener("click", generateOpportunityProposalPdf);
 [els.proposalConsumption].forEach((field) => {
  field.addEventListener("change", () => renderProposalMonthlyRows(readOpportunityProposalFromForm()));
 });
 els.proposalPower.addEventListener("input", recalculateProposalGenerationFromPower);
 els.proposalPower.addEventListener("change", recalculateProposalGenerationFromPower);
 [
  els.proposalKitValue,
  els.proposalDistanceKm,
  els.proposalLaborPerPanel,
  els.proposalInstallMaterialCost,
  els.proposalExtraCost,
  els.proposalTaxPercent,
  els.proposalCommissionPercent,
  els.proposalTargetMarginPercent,
  els.proposalPriceAdjustmentPercent,
  els.proposalModuleQuantity,
 ].forEach((field) => field.addEventListener("input", () => updateProposalPricingUi(true)));
 els.proposalInvestment.addEventListener("input", () => updateProposalPricingUi(false));
 els.openOpportunityMapBtn.addEventListener("click", openCurrentOpportunityMap);
 els.crmMapBtn.addEventListener("click", openCrmMapDialog);
 els.openCrmRouteBtn.addEventListener("click", openVisibleCrmRoute);
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
  "#crmCloseStart",
  "#crmCloseEnd",
  "#crmPendingOnly",
  "#crmStaleOnly",
  "#receberStatus",
  "#receberPeriodStart",
  "#receberPeriodEnd",
  "#pagarSearch",
  "#pagarStatus",
  "#pagarPeriodStart",
  "#pagarPeriodEnd",
  "#salesSearch",
  "#bankSearch",
  "#bankStatus",
  "#bankAccountFilter",
  "#bankDateStart",
  "#bankDateEnd",
  "#bankMonthFilter",
  "#bankYearFilter",
  "#peopleSearch",
  "#categoryReportType",
  "#reportStart",
  "#reportEnd",
  "#dreBasis",
 ].forEach((selector) => document.querySelector(selector).addEventListener("input", renderAll));

 els.opportunityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.opportunityDialog.close();
   return;
  }
  saveOpportunity();
 });
 els.newOpportunityPersonBtn.addEventListener("click", createPersonFromOpportunityDialog);

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
 els.transactionEntryAmount.addEventListener("input", renderTransactionInstallmentPreview);
 els.transactionInstallments.addEventListener("input", renderTransactionInstallmentPreview);
 els.transactionInstallmentInterval.addEventListener("change", updateTransactionInstallmentUi);
 els.transactionCustomDays.addEventListener("input", renderTransactionInstallmentPreview);
 els.newTransactionPersonBtn.addEventListener("click", createPersonFromTransactionDialog);
 els.newTransactionProjectBtn.addEventListener("click", createProjectFromTransactionDialog);
 els.newTransactionProjectFieldBtn.addEventListener("click", createProjectFromTransactionDialog);
 document.querySelector("#addAllocationBtn").addEventListener("click", () => addAllocationRow());

 els.transactionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
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
  if (event.submitter.value === "cancel") {
   els.saleDialog.close();
   return;
  }
  saveSale();
 });

 els.bankForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.bankDialog.close();
   return;
  }
  saveBankClassification();
 });
 els.newBankProjectBtn.addEventListener("click", createProjectFromBankDialog);
 els.addBankAllocationBtn.addEventListener("click", () => addBankAllocationRow());

 els.bankSyncProvider.addEventListener("change", updateBankSyncHint);
 els.bankSyncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.bankSyncDialog.close();
   return;
  }
  handleBankSyncSubmit();
 });
 els.bankApiForm.addEventListener("submit", saveBankApiConfig);
 els.syncBankApiNowBtn.addEventListener("click", syncBankApiConfigFromForm);

 els.projectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveProject();
 });
 els.newProjectCustomerBtn.addEventListener("click", createPersonFromProjectForm);
 els.newQuickProjectCustomerBtn.addEventListener("click", createPersonFromQuickProjectDialog);
 els.quickProjectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.quickProjectDialog.close();
   quickProjectTarget = "transaction";
   return;
  }
  saveQuickProjectFromTransaction();
 });

 document.querySelector("#projectSearch").addEventListener("input", renderProjects);
 document.querySelectorAll("#projetos .project-filters input, #projetos .project-filters select").forEach((field) => {
  field.addEventListener("input", renderProjectDashboard);
  field.addEventListener("change", renderProjectDashboard);
 });
 document.querySelector("#clearProjectDashboardFilters").addEventListener("click", clearProjectDashboardFilters);
 document.querySelector("#exportProjectDashboardCsv").addEventListener("click", exportProjectDashboardCsv);
 document.querySelector("#printProjectDashboard").addEventListener("click", () => window.print());
 document.querySelectorAll("[data-close-project-drawer]").forEach((item) => item.addEventListener("click", closeProjectDrawer));
 els.projectReportSelect.addEventListener("input", renderProjectReports);
 document.querySelector("#exportProjectCsv").addEventListener("click", exportProjectsCsv);
 els.installationForm.addEventListener("submit", saveInstallation);
 [
  els.installationSearch,
  els.installationDateStart,
  els.installationDateEnd,
  els.installationTypeFilter,
  els.installationStatusFilter,
 ].forEach((field) => {
  field.addEventListener("input", renderInstallations);
  field.addEventListener("change", renderInstallations);
 });
 [
  els.installationClosedDate,
  els.installationPanels,
  els.installationOutsourcingCost,
 ].forEach((field) => {
  field.addEventListener("input", updateInstallationFormCalculations);
  field.addEventListener("change", updateInstallationFormCalculations);
 });
 els.installationServiceType.addEventListener("change", () => {
  renderTechnicalPhotoGrid(els.installationServiceType.value);
  updateInstallationFormCalculations();
 });
 els.installationLaborRows.addEventListener("input", updateInstallationFormCalculations);
 els.installationLaborRows.addEventListener("change", updateInstallationFormCalculations);
 els.installationLaborRows.addEventListener("change", handleInstallationLaborWorkerSelect);
 els.addInstallationWorkerBtn.addEventListener("click", addInstallationWorker);
 els.toggleInstallationFormBtn.addEventListener("click", () => {
  const isHidden = els.installationForm.classList.contains("hidden");
  if (isHidden) resetInstallationForm();
  setInstallationFormVisible(isHidden);
 });
 els.resetInstallationFilters.addEventListener("click", clearInstallationFilters);
 els.technicalPhotoGrid.addEventListener("change", handleTechnicalPhotoUpload);
 els.technicalPhotoGrid.addEventListener("click", handleTechnicalPhotoRemove);
 els.fillSampleTechnicalReportBtn.addEventListener("click", fillSampleTechnicalReport);
 els.generateTechnicalReportBtn.addEventListener("click", () => generateTechnicalDeliveryPdf());
 els.deleteInstallationBtn.addEventListener("click", deleteCurrentInstallation);

 document.querySelector("#newProtocolBtn").addEventListener("click", () => openProtocolDialog());
 document.querySelector("#newProtocolInlineBtn").addEventListener("click", () => openProtocolDialog());
 document.querySelector("#protocolSettingsBtn").addEventListener("click", openProtocolSettingsDialog);
 els.protocolForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.protocolDialog.close();
   return;
  }
  saveProtocol();
 });
 els.newProtocolCustomerBtn.addEventListener("click", createPersonFromProtocolDialog);
 [
  els.protocolSearch,
  els.protocolFilterUtility,
  els.protocolFilterActivityType,
  els.protocolFilterStatus,
  els.protocolFilterResponsible,
  els.protocolFilterCity,
  els.protocolFilterProject,
  els.protocolFilterDeadline,
  els.protocolFilterPriority,
  els.protocolFilterPeriod,
 ].forEach((field) => field.addEventListener("input", renderProtocols));
 document.querySelector("#clearProtocolFilters").addEventListener("click", clearProtocolFilters);
 document.querySelectorAll("[data-close-protocol-drawer]").forEach((item) => item.addEventListener("click", closeProtocolDrawer));
 document.querySelectorAll("[data-protocol-tab]").forEach((button) => {
  button.addEventListener("click", () => setProtocolTab(button.dataset.protocolTab));
 });
 els.addUtilityCompanyBtn.addEventListener("click", addUtilityCompany);
 els.addActivityTypeBtn.addEventListener("click", addActivityType);

 els.personForm.addEventListener("submit", (event) => {
  event.preventDefault();
  savePerson();
 });
 els.quickPersonForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter.value === "cancel") {
   els.quickPersonDialog.close();
   return;
  }
  saveQuickPersonFromTransaction();
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
  bankApiConfigs: [],
  transactions: [],
  users: [],
  invoices: [],
  stockItems: [],
  stockMovements: [],
  stockLocations: [],
  installationWorkers: [],
  installations: [],
  opportunities: [],
  interactions: [],
  tasks: [],
  sellers: [],
  utilityCompanies: [],
  protocolActivityTypes: [],
  protocols: [],
  protocolHistory: [],
  maintenance: { enabled: false, message: "", startedAt: "", startedBy: "" },
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
  bankApiConfigs: Array.isArray(data.bankApiConfigs) ? data.bankApiConfigs : [],
  transactions: Array.isArray(data.transactions) ? data.transactions : [],
  users: Array.isArray(data.users) ? data.users : [],
  invoices: Array.isArray(data.invoices) ? data.invoices : [],
  stockItems: Array.isArray(data.stockItems) ? data.stockItems : [],
  stockMovements: Array.isArray(data.stockMovements) ? data.stockMovements : [],
  stockLocations: Array.isArray(data.stockLocations) ? data.stockLocations : [],
  installationWorkers: Array.isArray(data.installationWorkers) ? data.installationWorkers : [],
  installations: Array.isArray(data.installations) ? data.installations : [],
  opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
  interactions: Array.isArray(data.interactions) ? data.interactions : [],
  tasks: Array.isArray(data.tasks) ? data.tasks : [],
  sellers: Array.isArray(data.sellers) ? data.sellers : [],
  utilityCompanies: Array.isArray(data.utilityCompanies) ? data.utilityCompanies : [],
  protocolActivityTypes: Array.isArray(data.protocolActivityTypes) ? data.protocolActivityTypes : [],
  protocols: Array.isArray(data.protocols) ? data.protocols : [],
  protocolHistory: Array.isArray(data.protocolHistory) ? data.protocolHistory : [],
  maintenance: data.maintenance && typeof data.maintenance === "object"
   ? {
     enabled: Boolean(data.maintenance.enabled),
     message: data.maintenance.message || "",
     startedAt: data.maintenance.startedAt || "",
     startedBy: data.maintenance.startedBy || "",
    }
   : { enabled: false, message: "", startedAt: "", startedBy: "" },
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
  ownerUserId: "",
  projectId: "",
  contractId: "",
  contractGeneratedAt: "",
  installationId: "",
  location: { address: "", latitude: "", longitude: "" },
  driveFolderUrl: "",
  attachments: [],
  proposal: {},
  serviceType: "",
  postSaleDueDate: "",
  closedDate: "",
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
  locationId: normalized.stockLocations[0].id || "",
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
  serviceType: "instalacao_projeto",
  status: "programada",
  closedDate: "",
  postSaleDueDate: "",
  postSaleContactedAt: "",
  deadlineDate: "",
  scheduledDate: "",
  completedDate: "",
  panels: 0,
  outsourcingCost: 0,
  team: "",
  labor: [],
  technicalReport: {
   warrantyStartDate: "",
   technician: "",
   whatsapp: "",
   email: "",
   summary: "",
   photos: [],
   generatedAt: "",
  },
  materials: "",
  notes: "",
  conclusion: "",
  opportunityId: "",
  contractId: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...item,
 })).map((item) => ({
  ...item,
  labor: Array.isArray(item.labor) ? item.labor : [],
  technicalReport: {
   warrantyStartDate: "",
   technician: "",
   whatsapp: "",
   email: "",
   summary: "",
   photos: [],
   generatedAt: "",
   ...(item.technicalReport && typeof item.technicalReport === "object" ? item.technicalReport : {}),
  },
 })).map((item) => ({
  ...item,
  technicalReport: {
   ...item.technicalReport,
   photos: Array.isArray(item.technicalReport.photos) ? item.technicalReport.photos : [],
  },
 }));

 normalized.installationWorkers = normalized.installationWorkers.map((item) => ({
  id: crypto.randomUUID(),
  name: "",
  role: "Técnico",
  dailyRate: 0,
  active: true,
  createdAt: "",
  updatedAt: "",
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
  sectors: null,
  active: true,
  createdAt: "",
  ...item,
 })).map((user) => {
  const sectors = normalizeUserSectors(user);
  return {
   ...user,
   role: user.role === "administrador" ? "administrador" : "usuario",
   sectors,
  };
 });

 if (!normalized.crmUnits.length) {
  normalized.crmUnits = [
   { id: "sorocaba-sp", name: "Sorocaba - SP" },
   { id: "maringa-pr", name: "Maring? - PR" },
  ];
 }

 if (!normalized.crmPipelines.length) {
  normalized.crmPipelines = [
   { id: "vendas", name: "Vendas" },
   { id: "manutencao", name: "Manutenúo preventiva" },
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
  unitId: normalized.crmUnits[0].id || "",
  pipelineId: normalized.crmPipelines[0].id || "",
  stageId: normalized.opportunityStages[0].id || "triagem",
  owner: "",
  ownerUserId: "",
  phone: "",
  email: "",
  projectId: "",
  tags: [],
  pendingActivity: false,
  nextActivityDate: "",
  notes: "",
  location: { address: "", latitude: "", longitude: "" },
  driveFolderUrl: "",
  attachments: [],
  proposal: {},
  serviceType: "",
  postSaleDueDate: "",
  closedDate: "",
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
 deduplicateProjects(normalized);

 normalized.costCenters = normalized.costCenters.map((item) => ({
  id: crypto.randomUUID(),
  projectId: "",
  code: "",
  name: "",
  active: true,
  ...item,
 }));

 normalized.utilityCompanies = normalized.utilityCompanies.map((item) => ({
  id: crypto.randomUUID(),
  name: "",
  active: true,
  ...item,
 }));
 if (!normalized.utilityCompanies.length) {
  normalized.utilityCompanies = UTILITY_COMPANY_DEFAULTS.map((item) => ({ ...item, active: true }));
 }

 normalized.protocolActivityTypes = normalized.protocolActivityTypes.map((item) => ({
  id: crypto.randomUUID(),
  name: "",
  active: true,
  ...item,
 }));
 if (!normalized.protocolActivityTypes.length) {
  normalized.protocolActivityTypes = PROTOCOL_ACTIVITY_TYPE_DEFAULTS.map((item) => ({ ...item, active: true }));
 }

 normalized.protocols = normalized.protocols.map((item) => ({
  id: crypto.randomUUID(),
  internalNumber: "",
  protocolNumber: "",
  activityTypeId: "",
  utilityCompanyId: "",
  customerId: "",
  city: "",
  consumerUnit: "",
  projectId: "",
  status: "novo",
  responsibleUserId: "",
  openedAt: "",
  utilityDeadline: "",
  expectedDate: "",
  lastMovementAt: "",
  priority: "media",
  notes: "",
  checklist: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...item,
 }));

 normalized.protocolHistory = normalized.protocolHistory.map((item) => ({
  id: crypto.randomUUID(),
  protocolId: "",
  action: "registro",
  fromStatus: "",
  toStatus: "",
  user: "",
  createdAt: new Date().toISOString(),
  notes: "",
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
  allocations: [],
  notes: "",
  transactionId: "",
  invoiceId: "",
  reconciliationHistory: [],
  ...item,
 }));
 normalized.bankMovements.forEach((item) => {
  item.allocations = normalizeAllocations(item, normalized.projects);
  item.projectId = item.allocations.length === 1 ? item.allocations[0].projectId : "";
 });
 hydrateBankMovementNaturalKeys(normalized.bankMovements);

 normalized.bankAccounts = normalized.bankAccounts.map((item) => ({
  id: item.accountId || item.id || crypto.randomUUID(),
  accountKey: item.accountKey || `${item.bankId || "Banco"}-${item.accountId || item.id || ""}`,
  accountId: item.accountId || item.id || "",
  bankId: item.bankId || "Banco",
  balance: Number(item.balance || 0),
  balanceDate: item.balanceDate || "",
  investmentBalance: Number(item.investmentBalance || 0),
  investmentDate: item.investmentDate || "",
  investmentSource: item.investmentSource || "",
  source: item.source || "ofx",
  updatedAt: item.updatedAt || "",
  syncProvider: item.syncProvider || "mock",
  syncEndpoint: item.syncEndpoint || "",
  lastSyncedAt: item.lastSyncedAt || "",
  ...item,
 }));

 normalized.bankApiConfigs = normalized.bankApiConfigs.map((item) => ({
  id: crypto.randomUUID(),
  provider: "inter",
  accountKey: "",
  endpoint: "",
  lookbackDays: 1,
  autoDaily: true,
  active: true,
  lastSyncedAt: "",
  lastAutoSyncDate: "",
  lastResult: "",
  notes: "",
  createdAt: "",
  updatedAt: "",
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

 seedInstallationBacklog(normalized);
 deduplicateProjects(normalized);

 return normalized;
}

function seedSlug(value) {
 return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";
}

function parseCompactDate(value) {
 const text = String(value || "").replace(/\D/g, "");
 if (text.length !== 8) return todayIso;
 return `${text.slice(4, 8)}-${text.slice(2, 4)}-${text.slice(0, 2)}`;
}

function installationSeedStatus(seed) {
 return String(seed.note || "").toLowerCase().includes("falta") ? "aguardando_material" : "aguardando_instalacao";
}

function projectDuplicateKey(project) {
 const source = [project.code, project.name].filter(Boolean).join(" ");
 const numeric = String(source).match(/\b\d{3,5}-\d{2}-\d{2}\b/);
 return numeric ? numeric[0] : extractProjectCode(source);
}

function remapProjectReferences(normalized, projectIdMap, costCenterIdMap = new Map()) {
 const scopedCollections = [
  "opportunities",
  "protocols",
  "transactions",
  "bankMovements",
  "invoices",
  "stockMovements",
  "installations",
 ];
 scopedCollections.forEach((collectionName) => {
  (normalized[collectionName] || []).forEach((item) => {
   if (item.projectId && projectIdMap.has(item.projectId)) item.projectId = projectIdMap.get(item.projectId);
   if (item.costCenterId && costCenterIdMap.has(item.costCenterId)) item.costCenterId = costCenterIdMap.get(item.costCenterId);
   if (Array.isArray(item.allocations)) {
    item.allocations = item.allocations.map((allocation) => ({
     ...allocation,
     projectId: projectIdMap.get(allocation.projectId) || allocation.projectId,
    }));
   }
  });
 });
}

function projectMergeScore(project, normalized) {
 const referenceCount = [
  "opportunities",
  "protocols",
  "transactions",
  "bankMovements",
  "invoices",
  "stockMovements",
  "installations",
 ].reduce((total, collectionName) => total + (normalized[collectionName] || []).filter((item) =>
  item.projectId === project.id ||
  (item.allocations || []).some((allocation) => allocation.projectId === project.id)
 ).length, 0);
 return referenceCount * 100
  + (project.id.startsWith("seed-") ? 0 : 50)
  + (Number(project.contractValue || 0) > 0 ? 20 : 0)
  + (Number(project.expectedCosts || 0) > 0 ? 10 : 0)
  + (project.status && project.status !== "ativo" ? 8 : 0)
  + Math.min(String(project.notes || "").length, 30);
}

function mergeProjectFields(target, duplicate) {
 target.code = target.code || duplicate.code || projectDuplicateKey(duplicate);
 target.name = target.name || duplicate.name;
 target.customerId = target.customerId || duplicate.customerId;
 target.costCenterId = target.costCenterId || duplicate.costCenterId;
 if ((!target.status || target.status === "ativo") && duplicate.status && duplicate.status !== "ativo") target.status = duplicate.status;
 target.startDate = target.startDate || duplicate.startDate;
 target.endDate = target.endDate || duplicate.endDate;
 target.contractValue = Number(target.contractValue || 0) || Number(duplicate.contractValue || 0);
 target.expectedCosts = Number(target.expectedCosts || 0) || Number(duplicate.expectedCosts || 0);
 target.targetMargin = Number(target.targetMargin || 0) || Number(duplicate.targetMargin || 0) || 20;
 target.notes = [target.notes, duplicate.notes].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join("\n");
}

function deduplicateProjects(normalized) {
 const groups = new Map();
 normalized.projects.forEach((project) => {
  const key = projectDuplicateKey(project);
  if (!key) return;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(project);
 });

 const projectIdMap = new Map();
 const costCenterIdMap = new Map();
 groups.forEach((projects) => {
  if (projects.length < 2) return;
  const [target, ...duplicates] = [...projects].sort((a, b) => projectMergeScore(b, normalized) - projectMergeScore(a, normalized));
  target.code = target.code || projectDuplicateKey(target);
  duplicates.forEach((duplicate) => {
   mergeProjectFields(target, duplicate);
   projectIdMap.set(duplicate.id, target.id);
   if (duplicate.costCenterId && target.costCenterId) costCenterIdMap.set(duplicate.costCenterId, target.costCenterId);
  });
 });

 if (!projectIdMap.size) return;
 remapProjectReferences(normalized, projectIdMap, costCenterIdMap);
 normalized.projects = normalized.projects.filter((project) => !projectIdMap.has(project.id));
 normalized.costCenters.forEach((costCenter) => {
  if (projectIdMap.has(costCenter.projectId)) costCenter.projectId = projectIdMap.get(costCenter.projectId);
 });
 const seenCostCenters = new Set();
 normalized.costCenters = normalized.costCenters.filter((costCenter) => {
  const key = costCenter.projectId || costCenter.id;
  if (seenCostCenters.has(key)) return false;
  seenCostCenters.add(key);
  return true;
 });
}

function seedInstallationBacklog(normalized) {
 INSTALLATION_BACKLOG_SEED.forEach((seed) => {
  const projectNameSeed = `${seed.code} - ${seed.client}`;
  const projectSlug = seedSlug(projectNameSeed);
  const closedDate = parseCompactDate(seed.date);
  const status = installationSeedStatus(seed);
  const serviceType = seed.serviceType || "instalacao_projeto";
  const personNameSeed = seed.client.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  let person = normalized.people.find((item) => normalizeText(item.name) === normalizeText(personNameSeed));
  if (!person) {
   person = {
    id: `seed-client-${projectSlug}`,
    type: "cliente",
    name: personNameSeed,
    document: "",
    contact: "",
   };
   normalized.people.push(person);
  }

  const seedProjectCode = projectDuplicateKey({ code: seed.code });
  let project = normalized.projects.find((item) =>
   projectDuplicateKey(item) === seedProjectCode ||
   normalizeText(item.name).includes(normalizeText(seed.code)) ||
   normalizeText(item.code).includes(normalizeText(seed.code))
  );
  if (!project) {
   project = {
    id: `seed-project-${projectSlug}`,
    code: "",
    name: projectNameSeed,
    customerId: person.id,
    status,
    startDate: closedDate,
    endDate: "",
    contractValue: 0,
    expectedCosts: 0,
    targetMargin: 20,
    costCenterId: `seed-cost-${projectSlug}`,
    notes: `Importado da lista de instalações em andamento. Situação inicial: ${seed.note}. Custos devem ser alimentados por mão de obra, terceirização, contas a pagar e saídas de estoque vinculadas ao projeto.`,
   };
   normalized.projects.push(project);
  } else {
   project.customerId = project.customerId || person.id;
   project.costCenterId = project.costCenterId || `seed-cost-${projectSlug}`;
  }

  if (!normalized.costCenters.some((item) => item.projectId === project.id || item.id === project.costCenterId)) {
   normalized.costCenters.push({
    id: project.costCenterId,
    projectId: project.id,
    code: project.code || project.name,
    name: project.name,
    active: true,
   });
  }

  const hasInstallation = normalized.installations.some((item) =>
   item.projectId === project.id ||
   normalizeText(item.notes).includes(normalizeText(seed.code))
  );
  if (!hasInstallation) {
   normalized.installations.push({
    id: `seed-installation-${projectSlug}`,
    projectId: project.id,
    customerId: person.id,
    serviceType,
    status,
    closedDate,
    postSaleDueDate: addBusinessDaysIso(closedDate, 2),
    postSaleContactedAt: "",
    deadlineDate: addBusinessDaysIso(closedDate, 15),
    scheduledDate: "",
    completedDate: "",
    panels: 0,
    outsourcingCost: 0,
    team: "",
    labor: [],
    technicalReport: {
     warrantyStartDate: "",
     technician: "",
     whatsapp: "",
     email: "",
     summary: "",
     photos: [],
     generatedAt: "",
    },
    materials: seed.note,
    notes: `Cadastro inicial criado pela lista de instalações em andamento (${seed.code}). Etapa inicial: ${installationStatusLabel(status)}. Ao consumir material do estoque, use Saída de material > Consumo em projeto para baixar estoque e lan?ar custo direto no projeto.`,
    conclusion: "",
    opportunityId: "",
    contractId: "",
    createdAt: new Date(`${closedDate}T12:00:00`).toISOString(),
    updatedAt: new Date().toISOString(),
   });
  }
 });
}

function persist(scopes) {
 if (isMaintenanceActive()) {
  setSyncStatus("Sistema em manutenúo - salvamento bloqueado", "error");
  toast("Sistema em manutenúo. Alteraúes não foram salvas.");
  return false;
 }
 localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
 scheduleRemoteSync(scopes);
 return true;
}

async function initRemoteSync() {
 if (!SHEETS_ENDPOINT) {
  setSyncStatus("Somente neste navegador (Sheets não configurado)", "offline");
  return;
 }

 setSyncStatus("Carregando dados compartilhados?", "syncing");
 try {
  const response = await fetchWithTimeout(SHEETS_ENDPOINT, {}, SYNC_TIMEOUT_MS);
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Falha ao carregar");
  remoteUpdatedAt = result.updatedAt || "";
  if (result.data) {
   const remoteState = normalizeState(result.data);
   Object.assign(state, remoteState);
   localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
   renderAll();
  }
  if (!enforceMaintenanceMode()) {
   setSyncStatus("Sincronizado com o Google Sheets", "ok");
  }
 } catch (error) {
  console.error(error);
  setSyncStatus("Sem conex?o com o Sheets ? usando dados locais", "error");
 }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
 const controller = new AbortController();
 const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
 return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout));
}

function normalizePersistScopes(scopes) {
 const input = Array.isArray(scopes) ? scopes : scopes ? [scopes] : inferPersistScopes();
 const valid = input.filter((scope) => scope === "all" || SAVE_SCOPE_FIELDS[scope]);
 return valid.length ? [...new Set(valid)] : inferPersistScopes();
}

function inferPersistScopes() {
 const view = document.body.dataset.view || "";
 if (["crm", "vendas"].includes(view)) return ["crm"];
 if (["receber", "pagar", "banco", "apisbancarias", "notasfiscais", "relatorios"].includes(view)) return ["financeiro"];
 if (view === "protocolos") return ["protocolo"];
 if (view === "estoque") return ["estoque"];
 if (["projetos", "instalacoes"].includes(view)) return ["projetos"];
 if (["usuarios", "pessoas"].includes(view)) return ["config"];
 return ["all"];
}

function cloneStateValue(value) {
 return JSON.parse(JSON.stringify(value ?? null));
}

function itemMergeStamp(item) {
 return item.updatedAt || item.createdAt || item.balanceDate || item.date || item.timestamp || "";
}

function mergeArrayById(remoteItems = [], localItems = []) {
 const merged = new Map();
 remoteItems.forEach((item) => {
  if (item.id) merged.set(item.id, cloneStateValue(item));
 });
 localItems.forEach((item) => {
  if (!item.id) return;
  const current = merged.get(item.id);
  if (!current) {
   merged.set(item.id, cloneStateValue(item));
   return;
  }
  const localStamp = itemMergeStamp(item);
  const remoteStamp = itemMergeStamp(current);
  if (localStamp && (!remoteStamp || localStamp >= remoteStamp)) {
   merged.set(item.id, cloneStateValue(item));
  }
 });
 return Array.from(merged.values());
}

function mergeStateForScopes(remoteState, localState, scopes) {
 const normalizedScopes = normalizePersistScopes(scopes);
 if (normalizedScopes.includes("all")) return normalizeState(cloneStateValue(localState));

 const merged = normalizeState(cloneStateValue(remoteState));
 normalizedScopes.forEach((scope) => {
  (SAVE_SCOPE_FIELDS[scope] || []).forEach((field) => {
   const remoteValue = remoteState[field] || [];
   const localValue = localState[field] || [];
   merged[field] = Array.isArray(remoteValue) && Array.isArray(localValue) ?
     mergeArrayById(remoteValue, localValue)
    : cloneStateValue(localValue);
  });
 });

 SHARED_MERGE_FIELDS.forEach((field) => {
  if (normalizedScopes.some((scope) => (SAVE_SCOPE_FIELDS[scope] || []).includes(field))) return;
  merged[field] = mergeArrayById(remoteState[field] || [], localState[field] || []);
 });

 return normalizeState(merged);
}

async function fetchRemoteForSectorSave() {
 const response = await fetchWithTimeout(SHEETS_ENDPOINT, {}, SYNC_TIMEOUT_MS);
 const result = await response.json();
 if (!result.ok) throw new Error(result.error || "Falha ao carregar versao atual");
 return {
  state: normalizeState(result.data || {}),
  updatedAt: result.updatedAt || "",
 };
}

function mergeLocalBankDataIntoRemote(remoteState, localState) {
 const merged = normalizeState(remoteState);
 let changed = false;

 const remoteMovementKeys = new Set(
  merged.bankMovements.flatMap((movement) => [movement.id, movement.importKey, movement.naturalKey].filter(Boolean))
 );
 const rescuedMovements = (localState.bankMovements || []).filter((movement) => {
  const keys = [movement.id, movement.importKey, movement.naturalKey].filter(Boolean);
  return keys.length && keys.every((key) => !remoteMovementKeys.has(key));
 });

 if (rescuedMovements.length) {
  merged.bankMovements.push(...rescuedMovements);
  hydrateBankMovementNaturalKeys(merged.bankMovements);
  changed = true;
 }

 (localState.bankAccounts || []).forEach((localAccount) => {
  const localKey = localAccount.accountKey || `${localAccount.bankId || "Banco"}-${localAccount.accountId || ""}`;
  const index = merged.bankAccounts.findIndex((remoteAccount) => (remoteAccount.accountKey || `${remoteAccount.bankId}-${remoteAccount.accountId}`) === localKey);
  if (index < 0) {
   merged.bankAccounts.push(localAccount);
   changed = true;
   return;
  }
  const remoteAccount = merged.bankAccounts[index];
  if ((localAccount.balanceDate || "") > (remoteAccount.balanceDate || "")) {
   merged.bankAccounts[index] = { ...remoteAccount, ...localAccount };
   changed = true;
  }
 });

 const remoteConfigKeys = new Set(merged.bankApiConfigs.map((config) => `${config.provider}:${config.accountKey}`));
 (localState.bankApiConfigs || []).forEach((localConfig) => {
  const key = `${localConfig.provider}:${localConfig.accountKey}`;
  if (!remoteConfigKeys.has(key)) {
   merged.bankApiConfigs.push(localConfig);
   changed = true;
  }
 });

 return { state: merged, changed };
}

function scheduleRemoteSync(scopes) {
 if (!SHEETS_ENDPOINT) return;
 normalizePersistScopes(scopes).forEach((scope) => pendingSyncScopes.add(scope));
 if (syncInFlight) {
  syncQueued = true;
  setSyncStatus("Salvo localmente. Aguardando sincronizacao...", "syncing");
  return;
 }
 window.clearTimeout(syncTimer);
 setSyncStatus("Salvo localmente. Sincronizando...", "syncing");
 syncTimer = window.setTimeout(pushToSheets, SYNC_DEBOUNCE_MS);
}

async function pushToSheets() {
 if (syncInFlight) {
  syncQueued = true;
  return;
 }

 syncInFlight = true;
 syncQueued = false;
 const scopes = pendingSyncScopes.size ? Array.from(pendingSyncScopes) : inferPersistScopes();
 pendingSyncScopes.clear();
 const localState = normalizeState(cloneStateValue(state));
 window.clearTimeout(syncTimer);
 setSyncStatus(`Sincronizando ${syncScopeLabel(scopes)} com o Google Sheets...`, "syncing");

 try {
  const latest = await fetchRemoteForSectorSave();
  const sectorState = mergeStateForScopes(latest.state, localState, scopes);
  const response = await fetchWithTimeout(
   SHEETS_ENDPOINT,
   {
    method: "POST",
    body: JSON.stringify({ data: sectorState, baseUpdatedAt: latest.updatedAt }),
   },
   SYNC_TIMEOUT_MS
  );
  const result = await response.json();
  if (!result.ok) {
   if (result.error === "conflict") {
    await retrySyncAfterConflict(scopes, localState);
    return;
   }
   throw new Error(result.error || "Falha ao salvar");
  }
  remoteUpdatedAt = result.updatedAt || remoteUpdatedAt;
  Object.assign(state, sectorState);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
  setSyncStatus("Sincronizado com o Google Sheets", "ok");
 } catch (error) {
  console.error(error);
  scopes.forEach((scope) => pendingSyncScopes.add(scope));
  setSyncStatus("Erro ao sincronizar - dados salvos neste computador", "error");
 } finally {
  syncInFlight = false;
  if (syncQueued) scheduleRemoteSync(Array.from(pendingSyncScopes));
 }
}

async function retrySyncAfterConflict(scopes, localState) {
 setSyncStatus("Conflito detectado. Mesclando somente o setor alterado...", "syncing");
 const latest = await fetchRemoteForSectorSave();
 const sectorState = mergeStateForScopes(latest.state, localState, scopes);

 const retryResponse = await fetchWithTimeout(
  SHEETS_ENDPOINT,
  {
   method: "POST",
   body: JSON.stringify({ data: sectorState, baseUpdatedAt: latest.updatedAt }),
  },
  SYNC_TIMEOUT_MS
 );
 const retryResult = await retryResponse.json();
 if (!retryResult.ok) throw new Error(retryResult.error || "Falha ao salvar apos conflito");
 remoteUpdatedAt = retryResult.updatedAt || remoteUpdatedAt;
 Object.assign(state, sectorState);
 localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
 renderAll();
 setSyncStatus("Sincronizado com o Google Sheets", "ok");
}

function syncScopeLabel(scopes) {
 const labels = {
  crm: "CRM/Vendas",
  financeiro: "Financeiro",
  protocolo: "Protocolo",
  estoque: "Estoque",
  projetos: "Projetos",
  config: "Configuracoes",
  all: "todos os dados",
 };
 return normalizePersistScopes(scopes).map((scope) => labels[scope] || scope).join(", ");
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

async function ensureMasterUser({ save = true } = {}) {
 let master = state.users.find((user) => user.username.toLowerCase() === MASTER_USERNAME);
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
  JSON.stringify(normalizeUserSectors(master)) !== JSON.stringify(DEFAULT_USER_SECTORS) ||
  master.active !== true
 ) {
  Object.assign(master, {
   name: "Administrador",
   username: MASTER_USERNAME,
   passwordHash,
   salt,
   role: "administrador",
   sectors: DEFAULT_USER_SECTORS.slice(),
   active: true,
  });
  changed = true;
 }

 if (changed && save) persist();
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
 const sessionUsername = session.username.toLowerCase();
 const user =
  state.users.find((item) => item.id === session.userId && item.username === session.username) ||
  state.users.find((item) => item.username.toLowerCase() === sessionUsername);
 return user && user.active ? user : null;
}

function isAdmin() {
 return currentSessionUser().role === "administrador";
}

function isMaintenanceActive() {
 return FORCE_MAINTENANCE_MODE || Boolean(state.maintenance.enabled);
}

function maintenanceMessage() {
 if (FORCE_MAINTENANCE_MODE) return FORCE_MAINTENANCE_MESSAGE;
 return state.maintenance.message || "Estamos realizando ajustes. Por favor, tente novamente em alguns minutos.";
}

function shouldBlockForMaintenance() {
 return isMaintenanceActive();
}

function showMaintenance() {
 els.loginScreen.classList.add("hidden");
 els.appShell.classList.add("hidden");
 els.maintenanceScreen.classList.remove("hidden");
 if (els.maintenanceMessage) els.maintenanceMessage.textContent = maintenanceMessage();
 setSyncStatus("Sistema em manutenúo", "error");
}

function hideMaintenance() {
 els.maintenanceScreen.classList.add("hidden");
}

function enforceMaintenanceMode() {
 if (shouldBlockForMaintenance()) {
  showMaintenance();
  return true;
 }
 hideMaintenance();
 return false;
}

function normalizeUserSectors(user) {
 if (user.role === "administrador") return DEFAULT_USER_SECTORS.slice();
 if (Array.isArray(user.sectors)) {
  const valid = user.sectors.filter((sector) => SECTOR_ALLOWED_VIEWS[sector]);
  if (valid.length) return [...new Set(valid)];
 }
 if (user.role === "estoque") return ["financeiro"];
 return DEFAULT_USER_SECTORS.slice();
}

function currentUserSectors() {
 const user = currentSessionUser();
 if (!user) return [];
 return normalizeUserSectors(user);
}

function allowedViewsForSectors(sectors) {
 return [...new Set(sectors.flatMap((sector) => SECTOR_ALLOWED_VIEWS[sector] || []))];
}

function canAccessView(view) {
 if (isAdmin()) return true;
 if (view === "usuarios") return false;
 return allowedViewsForSectors(currentUserSectors()).includes(view);
}

function defaultViewForRole() {
 if (isAdmin()) return "dashboard";
 const allowed = allowedViewsForSectors(currentUserSectors()).filter((view) => view !== "dashboard");
 return allowed[0] || "dashboard";
}

// Segunda camada de protecao: alem de bloquear a navegacao em setView(), as funcoes que
// gravam dados financeiros/administrativos tambem se recusam a rodar se chamadas direto
// (ex.: pelo console do navegador), nao so quando acionadas pela tela.
function guardViewAccess(view) {
 if (canAccessView(view)) return true;
 toast("Acesso restrito para o seu perfil.");
 return false;
}

function userAccessLabel(user) {
 if (user.role === "administrador") return "Administrador";
 return normalizeUserSectors(user)
  .map((sector) => SECTOR_LABELS[sector] || sector)
  .join(", ") || "Sem setor";
}

function roleLabel(role) {
 return ROLE_LABELS[role] || "Usuario";
}

function isCommercialUser(user) {
 if (!user.active) return false;
 if (user.role === "administrador") return false;
 const sectors = normalizeUserSectors(user);
 return sectors.includes("comercial") || sectors.includes("vendas");
}

function opportunityOwnerDisplay(opportunity) {
 if (opportunity.ownerUserId) {
  const linkedUser = state.users.find((user) => user.id === opportunity.ownerUserId);
  if (linkedUser) return linkedUser.name || linkedUser.username;
 }
 return opportunity.owner || "Sem respons\u00e1vel";
}

function canViewOpportunity(opportunity) {
 if (isAdmin()) return true;
 const user = currentSessionUser();
 if (!user) return false;
 if (opportunity.ownerUserId) return opportunity.ownerUserId === user.id;
 const owner = String(opportunity.owner || "").trim().toLowerCase();
 if (!owner) return false;
 return [user.name, user.username]
  .filter(Boolean)
  .map((value) => String(value).trim().toLowerCase())
  .includes(owner);
}

function opportunitiesVisibleToCurrentUser() {
 return state.opportunities.filter(canViewOpportunity);
}

function opportunityOwnerSelectOptions(currentOpportunity = null) {
 const sessionUser = currentSessionUser();
 const availableUsers = isAdmin() ? state.users.filter(isCommercialUser) : [sessionUser].filter(Boolean);
 const commercialUsers = availableUsers
  .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));
 const currentOwner = currentOpportunity.owner || "";
 const hasLegacyOwner = currentOwner && !commercialUsers.some((user) => user.id === currentOpportunity.ownerUserId || (user.name || user.username) === currentOwner);
 return [
  `<option value="">Sem respons\u00e1vel</option>`,
  ...commercialUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.name || user.username)}</option>`),
  hasLegacyOwner ? `<option value="legacy:${escapeHtml(currentOwner)}">${escapeHtml(currentOwner)} (texto antigo)</option>` : "",
 ].join("");
}

function setOpportunityOwnerValue(opportunity = null) {
 if (!els.opportunityOwner) return;
 els.opportunityOwner.innerHTML = opportunityOwnerSelectOptions(opportunity);
 const matchingUser = opportunity.ownerUserId ?
   state.users.find((user) => user.id === opportunity.ownerUserId)
  : state.users.find((user) => isCommercialUser(user) && (user.name || user.username) === opportunity.owner);
 if (matchingUser) {
  els.opportunityOwner.value = matchingUser.id;
 } else if (opportunity.owner) {
  els.opportunityOwner.value = `legacy:${opportunity.owner}`;
 } else if (!isAdmin() && currentSessionUser()) {
  els.opportunityOwner.value = currentSessionUser().id;
 } else {
  els.opportunityOwner.value = "";
 }
}

function readOpportunityOwnerFromForm() {
 const selected = els.opportunityOwner.value || "";
 if (!selected) return { owner: "", ownerUserId: "" };
 if (selected.startsWith("legacy:")) return { owner: selected.replace("legacy:", ""), ownerUserId: "" };
 const user = state.users.find((item) => item.id === selected);
 return { owner: user ? (user.name || user.username) : "", ownerUserId: user.id || "" };
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
 if (enforceMaintenanceMode()) return;
 els.loginScreen.classList.add("hidden");
 hideMaintenance();
 els.appShell.classList.remove("hidden");
 updateSessionUi();
 setView(defaultViewForRole());
}

function showLogin() {
 els.appShell.classList.add("hidden");
 hideMaintenance();
 els.loginScreen.classList.remove("hidden");
 els.loginPassword.value = "";
 els.loginError.textContent = "";
 els.loginUsername.focus();
}

function updateSessionUi() {
 const user = currentSessionUser();
 if (!user) return;
 els.sessionUserName.textContent = user.name || user.username;
 els.sessionUserRole.textContent = userAccessLabel(user);
 els.navItems.forEach((item) => {
  item.classList.toggle("hidden", !canAccessView(item.dataset.view));
 });
 document.querySelector("#newSaleInlineBtn").classList.toggle("hidden", !canAccessView("vendas") && !canAccessView("crm"));
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
   await ensureMasterUser({ save: false });
   const master = state.users.find((item) => item.username.toLowerCase() === MASTER_USERNAME);
   els.loginError.textContent = "";
   setSession(master);
   showApp();
   return;
  }

  const user = state.users.find((item) => item.username.toLowerCase() === normalizedUsername);

  if (!user || !user.active || !user.salt || !user.passwordHash) {
   els.loginError.textContent = "Usu?rio ou senha inv?lidos.";
   return;
  }

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
   els.loginError.textContent = "Usu?rio ou senha inv?lidos.";
   return;
  }

  if (isMaintenanceActive()) {
   setSession(user);
   showMaintenance();
   return;
  }

  els.loginError.textContent = "";
  setSession(user);
  showApp();
 } catch (error) {
  console.error(error);
  els.loginError.textContent = "Não foi possível entrar. Recarregue a p?gina e tente novamente.";
 }
}

function handleLogout() {
 clearSession();
 showLogin();
}

function selectedUserSectors() {
 return els.userSectorFields.filter((field) => field.checked).map((field) => field.dataset.userSector);
}

function setUserSectorFields(sectors) {
 const selected = new Set(sectors);
 els.userSectorFields.forEach((field) => {
  field.checked = selected.has(field.dataset.userSector);
 });
}

function updateUserSectorUi() {
 const isAdministrator = els.userRole.value === "administrador";
 els.userSectorFields.forEach((field) => {
  field.disabled = isAdministrator;
  if (isAdministrator) field.checked = true;
 });
}

function renderUsers() {
 const users = [...state.users].sort((a, b) => a.username.localeCompare(b.username));
 els.usersList.innerHTML = users.length ?
   users.map((user) => `
   <article class="person-item">
    <strong><span>${escapeHtml(user.name || user.username)}</span><span>${escapeHtml(userAccessLabel(user))}</span></strong>
    <span class="muted">@${escapeHtml(user.username)} ? ${roleLabel(user.role)} ? ${user.active ? "Ativo" : "Inativo"}</span>
    <div class="row-actions">
     <button type="button" data-user-action="edit" data-id="${user.id}">Editar</button>
     <button type="button" data-user-action="delete" data-id="${user.id}">Excluir</button>
    </div> ?
   </article>`).join("")
  : emptyMessage("Nenhum usu?rio cadastrado.");

 document.querySelectorAll("[data-user-action]").forEach((button) => {
  button.addEventListener("click", () => handleUserAction(button.dataset.userAction, button.dataset.id));
 });
}

async function saveUser(event) {
 event.preventDefault();
 if (!isAdmin()) {
  toast("Apenas administradores podem cadastrar usu?rios.");
  return;
 }
 const id = els.userId.value || crypto.randomUUID();
 const username = els.userUsername.value.trim();
 const password = els.userPassword.value;
 const existing = state.users.find((item) => item.id === id);

 const usernameTaken = state.users.some((item) => item.id !== id && item.username.toLowerCase() === username.toLowerCase());
 if (usernameTaken) {
  toast("J? existe um usu?rio com esse login.");
  return;
 }

 if (!existing && !password) {
  toast("Informe uma senha para o novo usu?rio.");
  return;
 }

 const sectors = els.userRole.value === "administrador" ? DEFAULT_USER_SECTORS.slice() : selectedUserSectors();
 if (els.userRole.value !== "administrador" && !sectors.length) {
  toast("Selecione pelo menos um setor para o usu?rio.");
  return;
 }

 let passwordHash = existing.passwordHash || "";
 let salt = existing.salt || "";
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
  sectors,
  active: els.userActive.checked,
  createdAt: existing.createdAt || new Date().toISOString(),
 };

 const index = state.users.findIndex((item) => item.id === id);
 if (index >= 0) state.users[index] = data;
 else state.users.push(data);

 els.userForm.reset();
 els.userId.value = "";
 els.userActive.checked = true;
 setUserSectorFields(DEFAULT_USER_SECTORS);
 updateUserSectorUi();
 persist("config");
 renderUsers();
 updateSessionUi();
 toast("Usu?rio salvo.");
}

function handleUserAction(action, id) {
 if (!isAdmin()) {
  toast("Apenas administradores podem gerenciar usu?rios.");
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
  setUserSectorFields(normalizeUserSectors(user));
  updateUserSectorUi();
  els.userActive.checked = user.active;
  return;
 }

 if (user.username === MASTER_USERNAME) {
  toast("O usu?rio master não pode ser exclu?do.");
  return;
 }

 if (getSession().userId === id) {
  toast("Voc? não pode excluir o pr?prio usu?rio logado.");
  return;
 }

 state.users = state.users.filter((item) => item.id !== id);
 persist("config");
 renderUsers();
 toast("Usu?rio exclu?do.");
}

function enhanceSearchableSelect(selectEl, { placeholder = "Buscar?" } = {}) {
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
  optionsBox.innerHTML = items.length ?
    items.map((option) => `<div class="searchable-select-option" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</div>`).join("")
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
 selectEl._searchableRefresh?.();
}

function normalizeAllocations(transaction, projects = state.projects) {
 const projectIds = new Set(projects.map((project) => project.id));
 const raw = Array.isArray(transaction.allocations) ? transaction.allocations : [];
 const valid = raw
  .filter((allocation) => allocation.projectId && projectIds.has(allocation.projectId))
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

function extractProjectCode(value) {
 const match = String(value || "").match(/\b(IEV)\s*-\s*(\d{3,5})(:-(\d{2}))(:-(\d{2}))\b/i);
 if (!match) return "";
 return [match[1].toUpperCase(), match[2], match[3], match[4]].filter(Boolean).join("-");
}

function projectDisplayCode(projectId) {
 const project = state.projects.find((item) => item.id === projectId);
 if (!project) return "";
 return extractProjectCode([project.code, project.name].filter(Boolean).join(" ")) || project.code || "";
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
 document.body.dataset.view = view;
 els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === view));
 els.views.forEach((section) => section.classList.toggle("active", section.id === view));
 els.viewTitle.textContent = viewNames[view];
 const isFinancialEntryView = view === "receber" || view === "pagar";
 document.querySelector("#newSaleBtn").classList.toggle("hidden", !isFinancialEntryView || !canAccessView("receber"));
 document.querySelector("#newTransactionBtn").classList.toggle("hidden", !isFinancialEntryView || (!canAccessView("receber") && !canAccessView("pagar")));
}

function renderAll() {
 els.currentPeriod.textContent = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
 }).format(today);
 hydrateCrmOptions();
 renderCrm();
 renderDashboard();
 renderTransactionTables();
 renderSales();
 renderProjects();
 renderProjectReports();
 renderProtocols();
 renderInstallations();
 renderBank();
 renderPeople();
 renderInvoices();
 renderStock();
 renderBankApiConfigs();
 renderCrm();
 renderReports();
 hydratePersonOptions();
 hydrateSalePeople();
 hydrateProjectOptions();
 hydrateInvoicePersonOptions();
 hydrateStatusOptions();
 runDailyBankApiSync();
}

function hydrateCrmOptions() {
 const unitOptions = state.crmUnits.map((unit) => `<option value="${unit.id}">${escapeHtml(unit.name)}</option>`).join("");
 const pipelineOptions = state.crmPipelines.map((pipeline) => `<option value="${pipeline.id}">${escapeHtml(pipeline.name)}</option>`).join("");
 const stageOptions = state.opportunityStages
  .sort((a, b) => a.order - b.order)
  .map((stage) => `<option value="${stage.id}">${escapeHtml(stage.name)}</option>`)
  .join("");
 const ownerOptions = [...new Set([
  ...(isAdmin() ? state.users.filter(isCommercialUser) : [currentSessionUser()].filter(Boolean)).map((user) => user.name || user.username),
  ...opportunitiesVisibleToCurrentUser().map((item) => opportunityOwnerDisplay(item)).filter((name) => name && name !== "Sem respons\u00e1vel"),
 ])]
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
 if (els.opportunityOwner) els.opportunityOwner.innerHTML = opportunityOwnerSelectOptions();
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
 const closeStart = els.crmCloseStart.value || "";
 const closeEnd = els.crmCloseEnd.value || "";
 const filteringByCloseDate = Boolean(closeStart || closeEnd);

 return state.opportunities.filter((item) => {
  const ownerName = opportunityOwnerDisplay(item);
  const haystack = [personName(item.personId), item.company, item.phone, item.number, projectName(item.projectId), ownerName, normalizeTags(item.tags).join(" ")].join(" ").toLowerCase();
  const wonDate = opportunityWonDate(item);
  return canViewOpportunity(item)
   && (els.crmUnitFilter.value === "todos" || !els.crmUnitFilter.value || item.unitId === els.crmUnitFilter.value)
   && (!els.crmPipelineFilter.value || item.pipelineId === els.crmPipelineFilter.value)
   && (els.crmOwnerFilter.value === "todos" || !els.crmOwnerFilter.value || ownerName === els.crmOwnerFilter.value)
   && (els.crmStageFilter.value === "todos" || !els.crmStageFilter.value || item.stageId === els.crmStageFilter.value)
   && (els.crmProjectFilter.value === "todos" || item.projectId === els.crmProjectFilter.value)
   && (!filteringByCloseDate || (isOpportunityWon(item) && (!closeStart || wonDate >= closeStart) && (!closeEnd || wonDate <= closeEnd)))
   && (!search || haystack.includes(search))
   && (!minValue || Number(item.value || 0) >= minValue)
   && (!maxValue || Number(item.value || 0) <= maxValue)
   && (!els.crmPendingOnly.checked || item.pendingActivity || isActivityDue(item))
   && (!els.crmStaleOnly.checked || isOpportunityStale(item));
 });
}

function kanbanColumn(stage, opportunities) {
 const isWonStage = stage.id === "ganho" || String(stage.name || "").toLowerCase().includes("ganha");
 const items = opportunities
  .filter((item) => item.stageId === stage.id)
  .sort((a, b) => {
   if (isWonStage) return opportunityWonDate(b).localeCompare(opportunityWonDate(a));
   return (b.lastMovedAt || b.updatedAt || b.createdAt || "").localeCompare(a.lastMovedAt || a.updatedAt || a.createdAt || "");
  });
 const total = sum(items.map((item) => item.value));
 const overdue = items.filter(isActivityDue).length;
 return `
  <section class="kanban-column" data-stage-id="${stage.id}">
   <header class="kanban-head" style="--stage-color:${stage.color}">
    <strong>${escapeHtml(stage.name)}</strong>
    <span>${items.length} lead${items.length === 1 ? "" : "s"} - ${money(total)}</span>
   </header>
   ${overdue ? `<div class="kanban-column-alert">${overdue} atividade${overdue === 1 ? "" : "s"} vencida${overdue === 1 ? "" : "s"}</div>` : ""}
   <div class="kanban-cards" data-drop-stage="${stage.id}">
    ${items.slice(0, 80).map(opportunityCard).join("") || `<div class="kanban-empty">Sem oportunidades</div>`}
    ${items.length > 80 ? `<div class="muted kanban-limit">Mostrando 80 de ${items.length}</div>` : ""}
   </div>
  </section>`;
}

function opportunityCard(item) {
 const flags = [item.pendingActivity ? "Pendente" : "", isActivityDue(item) ? "Hoje/atrasada" : "", isOpportunityStale(item) ? "Sem movimento" : ""].filter(Boolean);
 const movedDate = item.lastMovedAt.slice(0, 10) || item.updatedAt.slice(0, 10) || todayIso;
 const wonDate = isOpportunityWon(item) ? opportunityWonDate(item) : "";
 const project = item.projectId ? projectName(item.projectId) : "";
 const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
 const hasLocation = opportunityLocationText(item);
 return `
  <article class="opportunity-card" draggable="true" data-opportunity-id="${item.id}">
   <div class="opportunity-card-top">
    <strong>${escapeHtml(personName(item.personId))}</strong>
    <span>${formatDate(wonDate || movedDate)}</span>
   </div>
   <button class="opportunity-card-main" type="button" data-opportunity-action="edit" data-id="${item.id}">
    ${escapeHtml(item.number || "Sem numero")}
   </button>
   <span class="muted">${escapeHtml(item.company || unitName(item.unitId) || "Sem empresa")}</span>
   ${wonDate ? `<span class="muted">Ganho em ${formatDate(wonDate)}</span>` : ""}
   <div class="opportunity-meta"><span>${money(item.value)}</span><strong>${escapeHtml(opportunityOwnerDisplay(item))}</strong></div>
   <div class="tag-row">
    ${project ? `<span>${escapeHtml(project)}</span>` : ""}
    ${attachmentCount ? `<span>${attachmentCount} anexo${attachmentCount === 1 ? "" : "s"}</span>` : ""}
    ${hasLocation ? `<span>Mapa</span>` : ""}
    ${normalizeTags(item.tags).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
   </div>
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

function opportunityLocationText(item) {
 const location = item.location || {};
 const coords = [location.latitude, location.longitude].filter(Boolean).join(",");
 return coords || location.address || "";
}

function googleMapsUrlFromLocation(locationText) {
 return `https://www.google.com/maps/search/api=1&query=${encodeURIComponent(locationText)}`;
}

function googleMapsRouteUrl(locations) {
 const clean = locations.filter(Boolean).slice(0, 10);
 if (!clean.length) return "";
 const destination = clean[clean.length - 1];
 const waypoints = clean.slice(0, -1).join("|");
 const params = new URLSearchParams({ api: "1", travelmode: "driving", destination });
 if (waypoints) params.set("waypoints", waypoints);
 return `https://www.google.com/maps/dir/${params.toString()}`;
}

function normalizeOpportunityAttachments(value) {
 return Array.isArray(value) ? value.map((item) => ({
  id: item.id || crypto.randomUUID(),
  type: item.type || "outro",
  name: item.name || "",
  url: item.url || "",
  notes: item.notes || "",
  createdAt: item.createdAt || new Date().toISOString(),
 })) : [];
}

function addOpportunityAttachmentRow(entry = null) {
 opportunityAttachmentsDraft.push(entry || {
  id: crypto.randomUUID(),
  type: "foto",
  name: "",
  url: "",
  notes: "",
  createdAt: new Date().toISOString(),
 });
 renderOpportunityAttachmentRows();
}

function setOpportunityAttachmentStatus(message, tone = "neutral") {
 if (!els.opportunityAttachmentStatus) return;
 els.opportunityAttachmentStatus.textContent = message;
 els.opportunityAttachmentStatus.dataset.tone = tone;
}

function currentOpportunityClientName() {
 const selected = els.opportunityPerson.selectedOptions?.[0].textContent.trim();
 return selected && !selected.toLowerCase().includes("cadastre") ? selected : "Lead sem cadastro";
}

function currentOpportunityFolderName() {
 const number = els.opportunityNumber.value.trim() || nextOpportunityNumber();
 return `${number} - ${currentOpportunityClientName()}`.slice(0, 140);
}

function extractFirstUrl(text) {
 return String(text || "").match(/https:\/\/[^\s"'<>]+/i)?.[0] || "";
}

function inferAttachmentType(fileOrUrl) {
 const name = typeof fileOrUrl === "string" ? fileOrUrl.toLowerCase() : (fileOrUrl.name || "").toLowerCase();
 const mime = typeof fileOrUrl === "string" ? "" : (fileOrUrl.type || "").toLowerCase();
 if (mime.startsWith("image/") || /\.(png|jpeg|webp|gif|heic)$/i.test(name)) return "foto";
 if (name.includes("conta") || name.includes("energia")) return "conta_energia";
 if (mime.includes("pdf") || /\.pdf$/i.test(name)) return "pdf";
 if (/\.(xlsx|csv)$/i.test(name)) return "planilha";
 if (/\.(docx|txt)$/i.test(name)) return "documento";
 return "outro";
}

async function checkDriveAutomationAvailable() {
 if (driveAutomationCapability !== null) return driveAutomationCapability;
 if (!SHEETS_ENDPOINT) {
  driveAutomationCapability = false;
  return false;
 }
 try {
  const response = await fetchWithTimeout(`${SHEETS_ENDPOINT}capabilities=drive`, {}, 8000);
  const result = await response.json();
  driveAutomationCapability = Boolean(result.capabilities.driveUploads);
 } catch (error) {
  console.error(error);
  driveAutomationCapability = false;
 }
 return driveAutomationCapability;
}

async function postDriveAutomation(action, payload, timeoutMs = 60000) {
 const available = await checkDriveAutomationAvailable();
 if (!available) {
  throw new Error("Atualize e publique o Apps Script para ativar criação de pastas e upload autom?tico no Drive.");
 }
 const response = await fetchWithTimeout(
  SHEETS_ENDPOINT,
  {
   method: "POST",
   body: JSON.stringify({ action, ...payload }),
  },
  timeoutMs
 );
 const result = await response.json();
 if (!result.ok) throw new Error(result.error || "Falha no Google Drive");
 return result;
}

async function createOpportunityDriveFolderForCurrentLead() {
 try {
  setOpportunityAttachmentStatus("Criando pasta do lead no Google Drive...", "syncing");
  const result = await postDriveAutomation("crm.createLeadFolder", {
   folderName: currentOpportunityFolderName(),
   clientName: currentOpportunityClientName(),
   opportunityNumber: els.opportunityNumber.value.trim(),
  });
  els.opportunityDriveFolder.value = result.folderUrl || "";
  setOpportunityAttachmentStatus("Pasta criada. Agora arraste arquivos para enviar direto ao Drive.", "ok");
  toast("Pasta do lead criada no Google Drive.");
 } catch (error) {
  console.error(error);
  setOpportunityAttachmentStatus(error.message, "error");
  toast("Não foi possível criar a pasta automaticamente.");
 }
}

async function ensureOpportunityDriveFolder() {
 if (els.opportunityDriveFolder.value.trim()) return els.opportunityDriveFolder.value.trim();
 await createOpportunityDriveFolderForCurrentLead();
 return els.opportunityDriveFolder.value.trim();
}

function fileToBase64(file) {
 return new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
  reader.onerror = reject;
  reader.readAsDataURL(file);
 });
}

async function uploadOpportunityFile(file) {
 const folderUrl = await ensureOpportunityDriveFolder();
 if (!folderUrl) throw new Error("Informe ou crie a pasta do Drive antes de enviar arquivos.");
 const base64 = await fileToBase64(file);
 const result = await postDriveAutomation("crm.uploadLeadFile", {
  folderUrl,
  folderName: currentOpportunityFolderName(),
  fileName: file.name,
  mimeType: file.type || "application/octet-stream",
  base64,
 }, 90000);
 return {
  id: crypto.randomUUID(),
  type: inferAttachmentType(file),
  name: file.name,
  url: result.fileUrl || "",
  notes: "Enviado automaticamente ao Google Drive",
  createdAt: new Date().toISOString(),
 };
}

async function handleOpportunityFiles(fileList) {
 const files = [...(fileList || [])];
 if (!files.length) return;
 if (files.some((file) => file.size > 9 * 1024 * 1024)) {
  toast("Arquivo acima de 9 MB: envie direto no Drive e arraste o link.");
  setOpportunityAttachmentStatus("Arquivos acima de 9 MB devem ser enviados manualmente ao Drive.", "error");
  return;
 }
 try {
  setOpportunityAttachmentStatus(`Enviando ${files.length} arquivo(s) para o Google Drive...`, "syncing");
  for (const file of files) {
   const attachment = await uploadOpportunityFile(file);
   opportunityAttachmentsDraft.push(attachment);
  }
  renderOpportunityAttachmentRows();
  setOpportunityAttachmentStatus("Upload concluído. Salve a oportunidade para gravar os anexos.", "ok");
  toast("Arquivos anexados ao lead.");
 } catch (error) {
  console.error(error);
  setOpportunityAttachmentStatus(error.message, "error");
  toast("Upload autom?tico indispon?vel. Use o link da pasta do Drive.");
 } finally {
  if (els.opportunityFileInput) els.opportunityFileInput.value = "";
 }
}

function addOpportunityLinkAttachment(url) {
 if (!url) return false;
 opportunityAttachmentsDraft.push({
  id: crypto.randomUUID(),
  type: inferAttachmentType(url),
  name: url.includes("drive.google.com") ? "Arquivo Google Drive" : "Link externo",
  url,
  notes: "Link arrastado/colado no CRM",
  createdAt: new Date().toISOString(),
 });
 renderOpportunityAttachmentRows();
 setOpportunityAttachmentStatus("Link adicionado. Salve a oportunidade para gravar.", "ok");
 return true;
}

function handleOpportunityAttachmentDragOver(event) {
 event.preventDefault();
 els.opportunityAttachmentDropzone.classList.add("drag-active");
}

function handleOpportunityAttachmentDragLeave() {
 els.opportunityAttachmentDropzone.classList.remove("drag-active");
}

function handleOpportunityAttachmentDrop(event) {
 event.preventDefault();
 els.opportunityAttachmentDropzone.classList.remove("drag-active");
 const url = extractFirstUrl(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"));
 if (url && addOpportunityLinkAttachment(url)) return;
 handleOpportunityFiles(event.dataTransfer.files);
}

function handleOpportunityAttachmentPaste(event) {
 const text = event.clipboardData.getData("text/plain") || "";
 const url = extractFirstUrl(text);
 if (!url) return;
 event.preventDefault();
 addOpportunityLinkAttachment(url);
}

function handleOpportunityAttachmentAction(event) {
 const removeButton = event.target.closest("[data-remove-opportunity-attachment]");
 if (!removeButton) return;
 opportunityAttachmentsDraft = opportunityAttachmentsDraft.filter((item) => item.id !== removeButton.dataset.removeOpportunityAttachment);
 renderOpportunityAttachmentRows();
}

function readOpportunityAttachmentsFromForm() {
 if (!els.opportunityAttachmentRows) return [];
 return [...els.opportunityAttachmentRows.querySelectorAll("[data-attachment-row]")].map((row) => ({
  id: row.dataset.attachmentRow,
  type: row.querySelector("[data-attachment-type]").value || "outro",
  name: row.querySelector("[data-attachment-name]").value.trim() || "",
  url: row.querySelector("[data-attachment-url]").value.trim() || "",
  notes: row.querySelector("[data-attachment-notes]").value.trim() || "",
  createdAt: opportunityAttachmentsDraft.find((item) => item.id === row.dataset.attachmentRow).createdAt || new Date().toISOString(),
 })).filter((item) => item.name || item.url || item.notes);
}

function renderOpportunityAttachmentRows() {
 if (!els.opportunityAttachmentRows) return;
 els.opportunityAttachmentRows.innerHTML = opportunityAttachmentsDraft.length ?
   opportunityAttachmentsDraft.map((item) => `
   <article class="attachment-row" data-attachment-row="${item.id}">
    <label>Tipo
     <select data-attachment-type>
      ${[
       ["foto", "Foto"],
       ["conta_energia", "Conta de energia"],
       ["documento", "Documento"],
       ["pdf", "PDF"],
       ["planilha", "Planilha Excel"],
       ["midia", "M?dia"],
       ["outro", "Outro"],
      ].map(([value, label]) => `<option value="${value}" ${item.type === value ? "selected" : ""}>${label}</option>`).join("")}
     </select>
    </label>
    <label>Nome
     <input data-attachment-name maxlength="120" value="${escapeHtml(item.name)}" placeholder="Ex.: Conta de energia" />
    </label>
    <label class="attachment-url">Link do Drive
     <input data-attachment-url type="url" maxlength="300" value="${escapeHtml(item.url)}" placeholder="https://drive.google.com/..." />
    </label>
    <label class="attachment-notes">Observaúes
     <input data-attachment-notes maxlength="180" value="${escapeHtml(item.notes)}" />
    </label>
    <button class="secondary-btn" data-remove-opportunity-attachment="${item.id}" type="button">Remover</button>
   </article> ?
  `).join("")
  : emptyMessage("Nenhum anexo registrado. Crie uma pasta no Drive para o lead e cole os links dos arquivos aqui.");
}

function defaultProposalMaterialCost(moduleQuantity) {
 const qty = Number(moduleQuantity || 0);
 if (!qty) return 0;
 if (qty < 8) return 550;
 if (qty < 26) return 1455;
 return 6100;
}

function readProposalPricingFromForm() {
 const moduleQuantity = Number(els.proposalModuleQuantity.value || 0);
 const materialValue = els.proposalInstallMaterialCost.value;
 return {
  kitProvider: els.proposalKitProvider.value.trim() || "",
  kitValue: Number(els.proposalKitValue.value || 0),
  distanceKm: Number(els.proposalDistanceKm.value || 0),
  laborPerPanel: Number(els.proposalLaborPerPanel.value || 80),
  installMaterialCost: materialValue === "" || materialValue == null ? defaultProposalMaterialCost(moduleQuantity) : Number(materialValue || 0),
  extraCost: Number(els.proposalExtraCost.value || 0),
  taxPercent: Number(els.proposalTaxPercent.value || 5),
  commissionPercent: Number(els.proposalCommissionPercent.value || 5),
  targetMarginPercent: Number(els.proposalTargetMarginPercent.value || 20),
  priceAdjustmentPercent: Number(els.proposalPriceAdjustmentPercent.value || 0),
 };
}

function calculateProposalPricing(pricing = {}, saleValueInput = 0, moduleQuantityInput = 0) {
 const moduleQuantity = Number(moduleQuantityInput || els.proposalModuleQuantity.value || 0);
 const distanceCost = Number(pricing.distanceKm || 0) > 0 ? Number(pricing.distanceKm || 0) * 0.95 + 80 : 0;
 const laborCost = moduleQuantity * Number(pricing.laborPerPanel || 0);
 const materialCost = Number(pricing.installMaterialCost || 0);
 const fixedCost = Number(pricing.kitValue || 0) + distanceCost + laborCost + materialCost + Number(pricing.extraCost || 0);
 const variableRate = (Number(pricing.taxPercent || 0) + Number(pricing.commissionPercent || 0)) / 100;
 const targetMargin = Number(pricing.targetMarginPercent || 0) / 100;
 const denominator = Math.max(0.01, 1 - variableRate - targetMargin);
 const minimumPrice = fixedCost ? fixedCost / denominator : 0;
 const suggestedPrice = minimumPrice * (1 + Number(pricing.priceAdjustmentPercent || 0) / 100);
 const saleValue = Number(saleValueInput || suggestedPrice || 0);
 const taxCost = saleValue * (Number(pricing.taxPercent || 0) / 100);
 const commissionCost = saleValue * (Number(pricing.commissionPercent || 0) / 100);
 const totalCost = fixedCost + taxCost + commissionCost;
 const profit = saleValue - totalCost;
 const margin = saleValue ? profit / saleValue : 0;
 const index = targetMargin ? margin / targetMargin : 0;
 const status = margin >= targetMargin * 0.975 ? "ok" : margin >= targetMargin * 0.925 ? "atencao" : "revisar";
 return {
  distanceCost,
  laborCost,
  materialCost,
  fixedCost,
  taxCost,
  commissionCost,
  totalCost,
  minimumPrice,
  suggestedPrice,
  saleValue,
  profit,
  margin,
  index,
  status,
 };
}

function updateProposalPricingUi(syncInvestment = false) {
 if (!els.proposalPricingResult) return;
 const moduleQuantity = Number(els.proposalModuleQuantity.value || 0);
 if (els.proposalInstallMaterialCost && !els.proposalInstallMaterialCost.value && moduleQuantity) {
  els.proposalInstallMaterialCost.placeholder = String(defaultProposalMaterialCost(moduleQuantity));
 }
 const pricing = readProposalPricingFromForm();
 const currentInvestment = Number(els.proposalInvestment.value || 0);
 const result = calculateProposalPricing(pricing, currentInvestment, moduleQuantity);
 if (syncInvestment && els.proposalInvestment && result.suggestedPrice) {
  els.proposalInvestment.value = result.suggestedPrice.toFixed(2);
  if (els.opportunityValue) els.opportunityValue.value = result.suggestedPrice.toFixed(2);
 }
 const finalResult = syncInvestment ? calculateProposalPricing(pricing, Number(els.proposalInvestment.value || 0), moduleQuantity) : result;
 const statusLabel = finalResult.status === "ok" ? "OK" : finalResult.status === "atencao" ? "Aten\u00e7\u00e3o" : "Revisar";
 els.proposalPricingResult.innerHTML = `
  <article class="pricing-status pricing-${finalResult.status}">
   <strong>${statusLabel}</strong>
   <span>\u00cdndice de acerto: ${formatNumber(finalResult.index * 100, 2)}%</span>
  </article>
  <article><span>Custo fixo</span><strong>${money(finalResult.fixedCost)}</strong></article>
  <article><span>Impostos + comiss\u00e3o</span><strong>${money(finalResult.taxCost + finalResult.commissionCost)}</strong></article>
  <article><span>Pre?o m\u00ednimo</span><strong>${money(finalResult.minimumPrice)}</strong></article>
  <article><span>Pre?o sugerido</span><strong>${money(finalResult.suggestedPrice)}</strong></article>
  <article><span>Margem estimada</span><strong>${formatNumber(finalResult.margin * 100, 2)}%</strong></article>
 `;
}

function readOpportunityProposalFromForm() {
 const monthlyConsumption = [...(els.proposalMonthlyRows.querySelectorAll("[data-proposal-consumption-month]") || [])].map((input) => Number(input.value || 0));
 const monthlyAdjustmentPercent = [...(els.proposalMonthlyRows.querySelectorAll("[data-proposal-adjustment-month]") || [])].map((input) => Number(input.value || 0));
 const monthlyGeneration = [...(els.proposalMonthlyRows.querySelectorAll("[data-proposal-generation-month]") || [])].map((input) => Number(input.value || 0));
 return {
  consumptionKwh: Number(els.proposalConsumption.value || 0),
  generationKwh: Number(els.proposalGeneration.value || 0),
  monthlyConsumption,
  monthlyAdjustmentPercent,
  monthlyGeneration,
  powerKwp: Number(els.proposalPower.value || 0),
  moduleQuantity: Number(els.proposalModuleQuantity.value || 0),
  inverterType: els.proposalInverterType.value || "microinversor",
  inverterBrand: els.proposalInverterBrand.value.trim() || "",
  inverterQuantity: Number(els.proposalInverterQuantity.value || 0),
  moduleBrand: els.proposalModuleBrand.value.trim() || "",
  modulePowerWp: Number(els.proposalModulePower.value || 0),
  roofType: els.proposalRoofType.value || "telha_colonial",
  battery: els.proposalBattery.value.trim() || "",
  tariff: Number(els.proposalTariff.value || 0),
  paymentTerms: els.proposalPaymentTerms.value.trim() || "",
  deliveryDeadline: els.proposalDeliveryDeadline.value.trim() || "",
  investment: Number(els.proposalInvestment.value || 0),
  pricing: readProposalPricingFromForm(),
  acceptanceData: els.proposalAcceptanceData.value.trim() || "",
  notes: els.proposalNotes.value.trim() || "",
 };
}

const PROPOSAL_MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const PROPOSAL_GENERATION_FACTORS = [1.08, 1.03, 1.13, 0.97, 0.92, 0.80, 0.88, 0.90, 0.93, 1.11, 1.15, 1.12];

function averagePositive(values) {
 const nums = values.map(Number).filter((value) => value > 0);
 return nums.length ? sum(nums) / nums.length : 0;
}

function renderProposalMonthlyRows(proposal = {}) {
 if (!els.proposalMonthlyRows) return;
 const baseConsumption = Number(proposal.consumptionKwh || els.proposalConsumption.value || 0);
 const powerKwp = Number(proposal.powerKwp || els.proposalPower.value || 0);
 const baseGeneration = powerKwp > 0 ? powerKwp * 100 : Number(proposal.generationKwh || els.proposalGeneration.value || 0);
 const consumption = Array.isArray(proposal.monthlyConsumption) && proposal.monthlyConsumption.length ? proposal.monthlyConsumption : PROPOSAL_MONTHS.map(() => baseConsumption);
 const adjustment = Array.isArray(proposal.monthlyAdjustmentPercent) && proposal.monthlyAdjustmentPercent.length ?
   proposal.monthlyAdjustmentPercent
  : PROPOSAL_GENERATION_FACTORS.map((factor) => Math.round(factor * 100));
 const generation = Array.isArray(proposal.monthlyGeneration) && proposal.monthlyGeneration.length ?
   proposal.monthlyGeneration
  : adjustment.map((percent) => Math.round(baseGeneration * (Number(percent || 0) / 100)));
 if (els.proposalGeneration) {
  els.proposalGeneration.value = Math.round(averagePositive(generation) || 0);
 }
 els.proposalMonthlyRows.innerHTML = `
  <div class="proposal-month-head">M?s</div>
  <div class="proposal-month-head">Consumo</div>
  <div class="proposal-month-head">% ajuste</div>
  <div class="proposal-month-head">Geração</div>
  ${PROPOSAL_MONTHS.map((month, index) => `
   <label>${month}</label>
   <input data-proposal-consumption-month="${index}" type="number" min="0" step="0.01" value="${consumption[index] || ""}" />
   <input data-proposal-adjustment-month="${index}" type="number" min="0" step="0.01" value="${adjustment[index] || ""}" />
   <input data-proposal-generation-month="${index}" type="number" min="0" step="0.01" value="${generation[index] || ""}" />
  `).join("")}
 `;
 bindProposalMonthlyEvents();
}

function recalculateProposalGenerationFromPower() {
 if (!els.proposalMonthlyRows) return;
 const powerKwp = Number(els.proposalPower.value || 0);
 const baseGeneration = powerKwp * 100;
 const generationInputs = [...els.proposalMonthlyRows.querySelectorAll("[data-proposal-generation-month]")];
 const adjustmentInputs = [...els.proposalMonthlyRows.querySelectorAll("[data-proposal-adjustment-month]")];
 generationInputs.forEach((input, index) => {
  const percent = Number(adjustmentInputs[index].value || 0);
  input.value = baseGeneration > 0 && percent > 0 ? Math.round(baseGeneration * (percent / 100)) : "";
 });
 if (els.proposalGeneration) {
  els.proposalGeneration.value = Math.round(averagePositive(generationInputs.map((input) => Number(input.value || 0))) || 0);
 }
}

function updateProposalGenerationAverage() {
 if (!els.proposalMonthlyRows || !els.proposalGeneration) return;
 const values = [...els.proposalMonthlyRows.querySelectorAll("[data-proposal-generation-month]")].map((input) => Number(input.value || 0));
 els.proposalGeneration.value = Math.round(averagePositive(values) || 0);
}

function bindProposalMonthlyEvents() {
 els.proposalMonthlyRows.querySelectorAll("[data-proposal-adjustment-month]").forEach((input) => {
  input.addEventListener("input", recalculateProposalGenerationFromPower);
 });
 els.proposalMonthlyRows.querySelectorAll("[data-proposal-generation-month]").forEach((input) => {
  input.addEventListener("input", updateProposalGenerationAverage);
 });
}

function setOpportunityProposalForm(proposal = {}) {
 if (!els.proposalConsumption) return;
 els.proposalConsumption.value = proposal.consumptionKwh || "";
 els.proposalGeneration.value = proposal.generationKwh || "";
 renderProposalMonthlyRows(proposal);
 els.proposalPower.value = proposal.powerKwp || "";
 els.proposalModuleQuantity.value = proposal.moduleQuantity || "";
 els.proposalInverterType.value = proposal.inverterType || "microinversor";
 els.proposalInverterBrand.value = proposal.inverterBrand || "";
 els.proposalInverterQuantity.value = proposal.inverterQuantity || "";
 els.proposalModuleBrand.value = proposal.moduleBrand || "";
 els.proposalModulePower.value = proposal.modulePowerWp || "";
 els.proposalRoofType.value = proposal.roofType || "telha_colonial";
 els.proposalBattery.value = proposal.battery || "";
 els.proposalTariff.value = proposal.tariff || "";
 els.proposalPaymentTerms.value = proposal.paymentTerms || "";
 els.proposalDeliveryDeadline.value = proposal.deliveryDeadline || "";
 els.proposalInvestment.value = proposal.investment || "";
 const pricing = proposal.pricing || {};
 if (els.proposalKitProvider) els.proposalKitProvider.value = pricing.kitProvider || "";
 if (els.proposalKitValue) els.proposalKitValue.value = pricing.kitValue || "";
 if (els.proposalDistanceKm) els.proposalDistanceKm.value = pricing.distanceKm ?? 100;
 if (els.proposalLaborPerPanel) els.proposalLaborPerPanel.value = pricing.laborPerPanel ?? 80;
 if (els.proposalInstallMaterialCost) els.proposalInstallMaterialCost.value = pricing.installMaterialCost || "";
 if (els.proposalExtraCost) els.proposalExtraCost.value = pricing.extraCost || "";
 if (els.proposalTaxPercent) els.proposalTaxPercent.value = pricing.taxPercent ?? 5;
 if (els.proposalCommissionPercent) els.proposalCommissionPercent.value = pricing.commissionPercent ?? 5;
 if (els.proposalTargetMarginPercent) els.proposalTargetMarginPercent.value = pricing.targetMarginPercent ?? 20;
 if (els.proposalPriceAdjustmentPercent) els.proposalPriceAdjustmentPercent.value = pricing.priceAdjustmentPercent ?? 0;
 updateProposalPricingUi(false);
 els.proposalAcceptanceData.value = proposal.acceptanceData || "";
 els.proposalNotes.value = proposal.notes || "";
}

function inverterWarrantyLabel(type) {
 if (type === "microinversor") return "Micro inversor: 15 anos";
 if (type === "hibrido") return "Inversor h\u00edbrido: conforme fabricante, base comercial de 10 anos";
 return "Inversor convencional: 10 anos";
}

function roofTypeLabel(type) {
 return {
  telha_colonial: "Telha colonial",
  metalico: "Met\u00e1lico",
  fibrocimento: "Fibrocimento",
  madeira: "Madeira",
  laje: "Laje",
  solo: "Solo",
 }[type] || "N\u00e3o informado";
}

function proposalChartSvg(consumption, generation) {
 const values = [...consumption, ...generation, 1].map(Number);
 const maxValue = Math.max(...values) * 1.18;
 const width = 920;
 const height = 320;
 const left = 58;
 const bottom = 48;
 const top = 28;
 const plotHeight = height - top - bottom;
 const groupWidth = (width - left - 18) / PROPOSAL_MONTHS.length;
 const barWidth = Math.min(22, groupWidth / 3);
 const y = (value) => top + plotHeight - (Number(value || 0) / maxValue) * plotHeight;
 const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
  const gy = top + plotHeight - ratio * plotHeight;
  return `<line x1="${left}" y1="${gy}" x2="${width - 10}" y2="${gy}" stroke="#e4ebe7"/><text x="8" y="${gy + 4}" font-size="12" fill="#62706a">${Math.round(maxValue * ratio)}</text>`;
 }).join("");
 const bars = PROPOSAL_MONTHS.map((month, index) => {
  const x = left + index * groupWidth + 8;
  const cy = y(consumption[index]);
  const gy = y(generation[index]);
  return `
   <rect x="${x}" y="${cy}" width="${barWidth}" height="${top + plotHeight - cy}" fill="#7aa6d8"/>
   <rect x="${x + barWidth + 4}" y="${gy}" width="${barWidth}" height="${top + plotHeight - gy}" fill="#f3a064"/>
   <text x="${x}" y="${height - 18}" font-size="12" fill="#10231d">${month}</text>
  `;
 }).join("");
 return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Consumo x gera&ccedil;&atilde;o por m&ecirc;s">
  <rect width="${width}" height="${height}" fill="#fff"/>
  ${grid}
  ${bars}
  <line x1="${left}" y1="${top + plotHeight}" x2="${width - 10}" y2="${top + plotHeight}" stroke="#9ca9a3"/>
  <rect x="${left}" y="6" width="14" height="10" fill="#7aa6d8"/><text x="${left + 20}" y="15" font-size="12" fill="#10231d">En. Cons</text>
  <rect x="${left + 108}" y="6" width="14" height="10" fill="#f3a064"/><text x="${left + 128}" y="15" font-size="12" fill="#10231d">En. Gerada</text>
 </svg>`;
}

function proposalHtml(opportunity, proposal) {
 const client = personName(opportunity.personId);
 const consumptionValues = Array.isArray(proposal.monthlyConsumption) && proposal.monthlyConsumption.some(Number) ?
   proposal.monthlyConsumption.map(Number)
  : PROPOSAL_MONTHS.map(() => Number(proposal.consumptionKwh || 0));
 const generationValues = Array.isArray(proposal.monthlyGeneration) && proposal.monthlyGeneration.some(Number) ?
   proposal.monthlyGeneration.map(Number)
  : (Array.isArray(proposal.monthlyAdjustmentPercent) && proposal.monthlyAdjustmentPercent.length ?
    proposal.monthlyAdjustmentPercent.map((percent) => Math.round(Number(proposal.powerKwp || 0) * 100 * (Number(percent || 0) / 100)))
   : PROPOSAL_GENERATION_FACTORS.map((factor) => Math.round(Number(proposal.powerKwp || 0) * 100 * factor)));
 const avgConsumption = averagePositive(consumptionValues) || Number(proposal.consumptionKwh || 0);
 const avgGeneration = averagePositive(generationValues) || Number(proposal.generationKwh || 0);
 const annualGeneration = sum(generationValues);
 const annualConsumption = sum(consumptionValues);
 const coverage = avgConsumption ? Math.min(100, (avgGeneration / avgConsumption) * 100) : 0;
 const investment = Number(proposal.investment || opportunity.value || 0);
 const tariff = Number(proposal.tariff || 0);
 const annualSavings = tariff ? Math.min(annualGeneration, annualConsumption || annualGeneration) * tariff : 0;
 const paybackYears = annualSavings ? investment / annualSavings : 0;
 const twentyFiveYearSavings = annualSavings ? annualSavings * 25 - investment : 0;
 const warranties = [
  "Placas: 15 anos contra defeito de fabrica\u00e7\u00e3o",
  "Efici\u00eancia das placas: 30 anos",
  inverterWarrantyLabel(proposal.inverterType),
  proposal.battery ? `Baterias: ${escapeHtml(proposal.battery)}` : "",
 ].filter(Boolean);
 return `<!doctype html>
 <html>
  <head>
   <meta charset="utf-8" />
   <title>Proposta fotovoltaica - ${escapeHtml(client)}</title>
   <style>
    @page { size: A4; margin: 16mm; }
    body { font-family: Arial, sans-serif; margin: 0; color: #10231d; background: #fff; line-height: 1.45; }
    header { display: flex; align-items: center; justify-content: space-between; border-bottom: 4px solid #0f7665; padding-bottom: 18px; margin-bottom: 24px; }
    header img { width: 170px; max-height: 76px; object-fit: contain; background: #050505; padding: 8px; }
    h1 { font-size: 28px; margin: 22px 0 8px; }
    h2 { font-size: 18px; margin: 26px 0 10px; color: #0f7665; }
    .muted { color: #5b6a64; }
    .hero { padding: 18px; border-radius: 12px; background: #eef6f3; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .grid.four { grid-template-columns: repeat(4, 1fr); }
    .box { border: 1px solid #d7dfdb; border-radius: 8px; padding: 12px; background: #fff; }
    .box span { display: block; color: #5b6a64; font-size: 12px; }
    .big { font-size: 22px; font-weight: 800; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #d7dfdb; text-align: left; padding: 9px; vertical-align: top; }
    th { color: #0f7665; font-size: 12px; text-transform: uppercase; }
    .chart { border: 1px solid #d7dfdb; border-radius: 10px; padding: 12px; page-break-inside: avoid; }
    .chart h2 { text-align: center; margin-top: 0; color: #10231d; }
    .investment { margin-top: 20px; padding: 18px; border-radius: 12px; background: #10231d; color: #fff; page-break-inside: avoid; }
    .investment h2 { color: #f5c451; margin-top: 0; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 40px; }
    .signature-line { border-top: 1px solid #10231d; padding-top: 8px; min-height: 80px; }
    footer { margin-top: 28px; font-size: 11px; color: #5b6a64; }
    .page-break { break-before: page; }
   </style>
  </head>
  <body>
   <header>
    <img src="assets/logo-lumeris.png" alt="Lumeris Engenharia" />
    <div><strong>Lumeris Engenharia</strong><br>Proposta fotovoltaica<br>${formatDate(todayIso)}<br>Validade: 3 dias</div>
   </header>
   <section class="hero">
    <h1>${escapeHtml(opportunity.number || opportunity.title || "Proposta")} - ${escapeHtml(client)}</h1>
    <p>${escapeHtml(opportunity.company || "")}</p>
    <p>Conforme solicitado, apresentamos a proposta comercial para fornecimento de sistema fotovoltaico conectado &agrave; rede el&eacute;trica, dimensionado com base no consumo informado e na gera&ccedil;&atilde;o estimada para o local de instala&ccedil;&atilde;o.</p>
   </section>
   <h2>Resumo t&eacute;cnico</h2>
   <section class="grid four">
    <div class="box"><span>Pot&ecirc;ncia total</span><div class="big">${formatNumber(proposal.powerKwp || 0)} kWp</div></div>
    <div class="box"><span>Gera&ccedil;&atilde;o m&eacute;dia</span><div class="big">${formatNumber(avgGeneration)} kWh/m&ecirc;s</div></div>
    <div class="box"><span>Consumo m&eacute;dio</span><div class="big">${formatNumber(avgConsumption)} kWh/m&ecirc;s</div></div>
    <div class="box"><span>Cobertura estimada</span><div class="big">${formatNumber(coverage)}%</div></div>
   </section>
   <h2>Radia&ccedil;&atilde;o solar considerada no projeto</h2>
   <p>O dimensionamento considera a disponibilidade m&eacute;dia de radia&ccedil;&atilde;o solar da regi&atilde;o, efeitos sazonais ao longo do ano, inclina&ccedil;&atilde;o, orienta&ccedil;&atilde;o dos m&oacute;dulos e condi&ccedil;&otilde;es clim&aacute;ticas t&iacute;picas. A gera&ccedil;&atilde;o pode variar m&ecirc;s a m&ecirc;s conforme temperatura, sombreamento, limpeza dos m&oacute;dulos e disponibilidade da rede el&eacute;trica.</p>
   <p>Os valores de gera&ccedil;&atilde;o mensal abaixo s&atilde;o estimativas t&eacute;cnicas utilizadas para comparar a energia consumida pelo cliente com a energia prevista do sistema proposto.</p>
   <section class="chart">
    <h2>Consumo x Gera&ccedil;&atilde;o</h2>
    ${proposalChartSvg(consumptionValues, generationValues)}
   </section>
   <table>
    <thead><tr><th>M&ecirc;s</th>${PROPOSAL_MONTHS.map((month) => `<th>${month}</th>`).join("")}<th>M&eacute;dia</th></tr></thead>
    <tbody>
     <tr><th>En. Cons</th>${consumptionValues.map((value) => `<td>${formatNumber(value, 0)}</td>`).join("")}<td>${formatNumber(avgConsumption, 0)}</td></tr>
     <tr><th>En. Gerada</th>${generationValues.map((value) => `<td>${formatNumber(value, 0)}</td>`).join("")}<td>${formatNumber(avgGeneration, 0)}</td></tr>
    </tbody>
   </table>
   <h2>Composi&ccedil;&atilde;o do projeto</h2>
   <table>
    <thead><tr><th>Item</th><th>Quantidade</th></tr></thead>
    <tbody>
     <tr><td>M&oacute;dulo fotovoltaico ${escapeHtml(proposal.moduleBrand || "A definir")} ${proposal.modulePowerWp ? `${formatNumber(proposal.modulePowerWp, 0)} Wp` : ""}</td><td>${formatNumber(proposal.moduleQuantity || 0, 0)}</td></tr>
     <tr><td>Inversor ${escapeHtml(proposal.inverterBrand || "A definir")} - ${escapeHtml(inverterWarrantyLabel(proposal.inverterType).split(":")[0])}</td><td>${formatNumber(proposal.inverterQuantity || 0, 0)}</td></tr>
     <tr><td>Estrutura de fixa&ccedil;&atilde;o para ${escapeHtml(roofTypeLabel(proposal.roofType))}</td><td>1 kit</td></tr>
     <tr><td><strong>Cabos solares 6 mm&sup2;</strong>, conectores e prote&ccedil;&otilde;es necess&aacute;rios para instala&ccedil;&atilde;o</td><td>Incluso</td></tr>
     <tr><td>Monitoramento, aterramento, string box/prote&ccedil;&otilde;es e homologa&ccedil;&atilde;o conforme escopo</td><td>Incluso</td></tr>
    </tbody>
   </table>
   <h2>Garantias</h2>
   <ul>${warranties.map((item) => `<li>${item}</li>`).join("")}</ul>
   <h2>Estimativa de ROI e payback</h2>
   <section class="grid">
    <div class="box"><span>Economia estimada anual</span><div class="big">${annualSavings ? money(annualSavings) : "Informar kWh"}</div></div>
    <div class="box"><span>Payback estimado</span><div class="big">${paybackYears ? `${formatNumber(paybackYears, 1)} anos` : "A calcular"}</div></div>
    <div class="box"><span>Economia projetada em 25 anos</span><div class="big">${annualSavings ? money(twentyFiveYearSavings) : "A calcular"}</div></div>
    <div class="box"><span>Valor m&eacute;dio do kWh</span><div class="big">${tariff ? money(tariff) : "N\u00e3o informado"}</div></div>
   </section>
   <div class="investment page-break">
    <h2>Pre&ccedil;o, entrega e condi&ccedil;&otilde;es de pagamento</h2>
    <section class="grid">
     <div><span>Valor total do sistema</span><div class="big">${money(investment)}</div></div>
     <div><span>Forma de pagamento</span><div class="big">${escapeHtml(proposal.paymentTerms || "A negociar")}</div></div>
     <div><span>Prazo de entrega</span><div>${escapeHtml(proposal.deliveryDeadline || "Ap\u00f3s chegada do kit, at\u00e9 20 dias \u00fateis para instala\u00e7\u00e3o, sujeito \u00e0 aprova\u00e7\u00e3o da concession\u00e1ria.")}</div></div>
     <div><span>Gera&ccedil;&atilde;o m&eacute;dia</span><div>${formatNumber(avgGeneration)} kWh/m&ecirc;s</div></div>
    </section>
   </div>
   <h2>Observa&ccedil;&otilde;es comerciais</h2>
   <p>${escapeHtml(proposal.notes || "Proposta sujeita \u00e0 vistoria t\u00e9cnica, disponibilidade de rede, aprova\u00e7\u00e3o da concession\u00e1ria, assinatura de contrato e disponibilidade dos equipamentos no ato da compra.")}</p>
   <h2>Aceite da proposta</h2>
   <p>Esta proposta, quando assinada, formaliza o aceite das condi&ccedil;&otilde;es t&eacute;cnicas e comerciais acima e servir&aacute; como base para emiss&atilde;o/assinatura do contrato de presta&ccedil;&atilde;o de servi&ccedil;os.</p>
   <section class="signatures">
    <div class="signature-line"><strong>Lumeris Engenharia</strong><br>Respons&aacute;vel comercial</div>
    <div class="signature-line"><strong>${escapeHtml(client)}</strong><br>${escapeHtml(proposal.acceptanceData || "CPF/CNPJ, endere\u00e7o e respons\u00e1vel pelo aceite")}</div>
   </section>
   <footer>Documento gerado pelo CRM Lumeris. Para envio ao cliente, salve como PDF na janela de impress&atilde;o.</footer>
   <script>window.addEventListener("load", () => setTimeout(() => window.print(), 400));</script>
  </body>
 </html>`;
}

function currentOpportunityDraftFromForm() {
 return {
  id: els.opportunityId.value || "",
  personId: els.opportunityPerson.value,
  company: els.opportunityCompany.value.trim(),
  number: els.opportunityNumber.value.trim(),
  title: els.opportunityNumber.value.trim(),
  value: Number(els.opportunityValue.value || 0),
  location: {
   address: els.opportunityAddress.value.trim() || "",
   latitude: els.opportunityLatitude.value.trim() || "",
   longitude: els.opportunityLongitude.value.trim() || "",
  },
 };
}

function generateOpportunityProposalPdf() {
 const opportunity = currentOpportunityDraftFromForm();
 const proposal = readOpportunityProposalFromForm();
 const win = window.open("", "_blank");
 if (!win) {
  toast("Permita pop-ups para gerar a proposta.");
  return;
 }
 win.document.write(proposalHtml(opportunity, proposal));
 win.document.close();
}

function openCurrentOpportunityMap() {
 const locationText = opportunityLocationText(currentOpportunityDraftFromForm());
 if (!locationText) {
  toast("Informe endere?o ou latitude/longitude para abrir o mapa.");
  return;
 }
 window.open(googleMapsUrlFromLocation(locationText), "_blank");
}

function openCrmMapDialog() {
 renderCrmMapList();
 els.crmMapDialog.showModal();
}

function renderCrmMapList() {
 if (!els.crmMapList) return;
 const rows = filteredOpportunities().filter(opportunityLocationText);
 els.crmMapList.innerHTML = rows.length ?
   rows.map((item) => {
   const location = opportunityLocationText(item);
   return `
    <article class="map-lead-item">
     <strong>${escapeHtml(personName(item.personId))}</strong>
     <span>${escapeHtml(item.number || item.company || "")}</span>
     <small>${escapeHtml(location)}</small>
     <a class="secondary-btn" href="${googleMapsUrlFromLocation(location)}" target="_blank" rel="noopener">Abrir no Google Maps</a>
    </article>`;
  }).join("")
  : emptyMessage("Nenhum lead vis?vel possui endere?o ou coordenadas.");
}

function openVisibleCrmRoute() {
 const locations = filteredOpportunities().map(opportunityLocationText).filter(Boolean);
 const url = googleMapsRouteUrl(locations);
 if (!url) {
  toast("Nenhum lead vis?vel possui localização para montar rota.");
  return;
 }
 window.open(url, "_blank");
}

function openOpportunityDialog(item = null) {
 els.opportunityForm.reset();
 hydrateCrmOptions();
 els.opportunityId.value = item.id || "";
 els.opportunityPerson.value = item.personId || els.opportunityPerson.value;
 els.opportunityCompany.value = item.company || "";
 els.opportunityNumber.value = item.number || nextOpportunityNumber();
 els.opportunityValue.value = item.value || 0;
 els.opportunityUnit.value = item.unitId || state.crmUnits[0].id || "";
 els.opportunityPipeline.value = item.pipelineId || els.crmPipelineFilter.value || state.crmPipelines[0].id || "";
 els.opportunityStage.value = item.stageId || state.opportunityStages[0].id || "";
 if (els.opportunityClosedDate) els.opportunityClosedDate.value = item.closedDate || (isOpportunityWon(item || {}) ? opportunityWonDate(item) : "");
 setOpportunityOwnerValue(item);
 els.opportunityPhone.value = item.phone || "";
 els.opportunityEmail.value = item.email || "";
 els.opportunityProject.value = item.projectId || "";
 els.opportunityTags.value = normalizeTags(item.tags).join(", ");
 els.opportunityNextActivity.value = item.nextActivityDate || "";
 els.opportunityPendingActivity.checked = Boolean(item.pendingActivity);
 els.opportunityNotes.value = item.notes || "";
 els.opportunityTitle.textContent = item ? "Editar oportunidade" : "Nova oportunidade";
 renderOpportunityHistory(item.id || "");
 els.opportunityDialog.showModal();
}

function saveOpportunity() {
 const now = new Date().toISOString();
 const id = els.opportunityId.value || crypto.randomUUID();
 const existing = state.opportunities.find((item) => item.id === id);
 const ownerData = readOpportunityOwnerFromForm();
 const closedDate = els.opportunityClosedDate.value || existing.closedDate || "";
 const stageId = els.opportunityStage.value;
 const data = {
  id,
  personId: els.opportunityPerson.value,
  company: els.opportunityCompany.value.trim(),
  number: els.opportunityNumber.value.trim() || nextOpportunityNumber(),
  value: Number(els.opportunityValue.value || 0),
  unitId: els.opportunityUnit.value,
  pipelineId: els.opportunityPipeline.value,
  stageId,
  closedDate: stageId === "ganho" ? closedDate : "",
  wonAt: stageId === "ganho" && closedDate ? new Date(`${closedDate}T12:00:00`).toISOString() : existing.wonAt || "",
  owner: ownerData.owner,
  ownerUserId: ownerData.ownerUserId,
  phone: els.opportunityPhone.value.trim(),
  email: els.opportunityEmail.value.trim(),
  projectId: els.opportunityProject.value,
  tags: normalizeTags(els.opportunityTags.value),
  pendingActivity: els.opportunityPendingActivity.checked,
  nextActivityDate: els.opportunityNextActivity.value,
  notes: els.opportunityNotes.value.trim(),
  createdAt: existing.createdAt || now,
  updatedAt: now,
  lastMovedAt: existing.lastMovedAt || now,
  lastContactAt: existing.lastContactAt || "",
 };

 const index = state.opportunities.findIndex((item) => item.id === id);
 if (index >= 0) {
  if (existing.stageId !== data.stageId) {
   addOpportunityHistory(id, "mudan?a de etapa", existing.stageId, data.stageId);
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
 addOpportunityHistory(id, "mudan?a de etapa", previousStage, newStageId);
 persist();
 renderCrm();
}

function renderOpportunityHistory(opportunityId) {
 const rows = state.opportunityHistory
  .filter((item) => item.opportunityId === opportunityId)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
 els.opportunityHistory.innerHTML = rows.length ?
   rows.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.action)}</span><span>${formatDate(row.createdAt.slice(0, 10))}</span></strong>
    <span class="muted">${escapeHtml(stageName(row.fromStageId) || "-")} ? ${escapeHtml(stageName(row.toStageId) || "-")} ? ${escapeHtml(row.user)}</span> ?
   </article>`).join("")
  : emptyMessage("Sem hist?rico registrado.");
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
 if (els.crmCloseStart) els.crmCloseStart.value = "";
 if (els.crmCloseEnd) els.crmCloseEnd.value = "";
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
 const ref = item.lastMovedAt.slice(0, 10) || item.updatedAt.slice(0, 10) || item.createdAt.slice(0, 10);
 return ref ? daysBetween(todayIso, ref) > 15 : false;
}

function currentCrmUser() {
 return localStorage.getItem("financeiro-lumeris-user") || "Usu?rio local";
}

function renderDashboard() {
 const receber = state.transactions.filter((item) => item.type === "receber");
 const pagar = state.transactions.filter((item) => item.type === "pagar");
 const receberAberto = sum(receber.filter((item) => item.status === "aberto"));
 const pagarAberto = sum(pagar.filter((item) => item.status === "aberto"));
 const receberVencidoItems = receber.filter(isOverdue);
 const receberVencido = sum(receberVencidoItems);
 const pagarVencido = sum(pagar.filter(isOverdue));
 const realizadoMes = sum(state.transactions.filter(isPaidThisMonth).map(signedAmount));

 document.querySelector("#kpiReceberAberto").textContent = money(receberAberto);
 document.querySelector("#kpiPagarAberto").textContent = money(pagarAberto);
 document.querySelector("#kpiReceberVencido").textContent = `${money(receberVencido)} vencido`;
 document.querySelector("#kpiReceberVencidoCard").textContent = money(receberVencido);
 document.querySelector("#kpiReceberVencidoCount").textContent = `${receberVencidoItems.length} lan?amento(s) vencido(s)`;
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
 const scheduledInstallations = state.installations.filter((item) => !["concluida", "cancelada"].includes(item.status));
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


function bankBalanceSourceLabel(account) {
 const source = account.source || "";
 if (source === "ofx") return "saldo do OFX";
 if (source === "inter_api") return "saldo da API Inter";
 if (source.endsWith("_api")) return "saldo da API banc?ria";
 return "saldo dos movimentos";
}

function accountTotalBalance(account) {
 return Number(account.balance || 0) + Number(account.investmentBalance || 0);
}

function isInterAccount(account) {
 return account.syncProvider === "inter" || account.source === "inter_api" || account.bankId === "077";
}

function renderBankBalances() {
 const accounts = latestBankAccounts();
 const totalBalance = accounts.reduce((total, account) => total + accountTotalBalance(account), 0);
 els.bankBalanceList.innerHTML = accounts.length ? `
   <article class="bank-balance-item bank-balance-total">
    <div>
     <strong>Saldo total banc?rio</strong>
     <span class="muted">${accounts.length} conta(s) somadas pelo saldo mais atual, incluindo investimentos vinculados</span>
    </div>
    <strong class="money">${money(totalBalance)}</strong>
   </article> ?
   ${accounts.map(renderBankBalanceItem).join("")}`
  : emptyMessage("Importe um arquivo OFX na aba Banco para exibir os saldos das contas.");
}

function renderBankBalanceItem(account) {
 if (!isInterAccount(account)) {
  return `
   <article class="bank-balance-item">
    <div>
     <strong>${escapeHtml(account.bankId)}</strong>
     <span class="muted">Conta ${escapeHtml(account.accountId || "não identificada")} ? ${account.balanceDate ? formatDate(account.balanceDate) : "sem data"} ? ${bankBalanceSourceLabel(account)}</span>
    </div>
    <strong class="money">${money(account.balance)}</strong>
   </article>`;
 }

 const investmentDate = account.investmentDate || account.balanceDate;
 return `
   <article class="bank-balance-item bank-balance-detail">
    <div>
     <strong>Inter ? Conta ${escapeHtml(account.accountId || "não identificada")}</strong>
     <span class="muted">${account.balanceDate ? formatDate(account.balanceDate) : "sem data"} ? ${bankBalanceSourceLabel(account)}</span>
    </div>
    <strong class="money">${money(account.balance)}</strong>
    <div>
     <strong>Investimentos Inter</strong>
     <span class="muted">${investmentDate ? formatDate(investmentDate) : "sem data"} ? ${account.investmentSource ? "saldo de investimentos" : "aguardando API/valor configurado"}</span>
    </div>
    <strong class="money">${money(account.investmentBalance || 0)}</strong>
    <div>
     <strong>Saldo total Inter</strong>
     <span class="muted">Conta corrente + investimentos</span>
    </div>
    <strong class="money">${money(accountTotalBalance(account))}</strong>
   </article>`;
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

 document.querySelector("#upcomingList").innerHTML = upcoming.length ?
   upcoming.map((item) => `
   <article class="mini-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${item.type === "receber" ? "Receber" : "Pagar"}</span>
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
 const periodStart = document.querySelector(`#${type}PeriodStart`).value;
 const periodEnd = document.querySelector(`#${type}PeriodEnd`).value;
 const tbody = document.querySelector(`#${type}Table`);
 const colspan = type === "receber" ? 8 : 7;

 const rows = state.transactions
  .filter((item) => item.type === type)
  .filter((item) => matchesTransaction(item, search, statusFilter))
  .filter((item) => (!periodStart || item.dueDate >= periodStart) && (!periodEnd || item.dueDate <= periodEnd))
  .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

 tbody.innerHTML = rows.length ?
   rows.map((item) => transactionRow(item, type)).join("")
  : `<tr><td colspan="${colspan}">${emptyMessage("Nenhum lan?amento encontrado.")}</td></tr>`;

 tbody.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => handleTransactionAction(button.dataset.action, button.dataset.id));
 });

 document.querySelector(`#${type}Total`).textContent = `Total: ${money(sum(rows))}`;
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

function bankMovementProjectLabel(movement) {
 const allocations = normalizeAllocations(movement);
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
  persist("financeiro");
  renderAll();
  toast("Lan?amento exclu?do.");
  return;
 }

 if (action === "toggle") {
  item.status = item.status === "aberto" ? (item.type === "receber" ? "recebido" : "pago") : "aberto";
  item.paidDate = item.status === "aberto" ? "" : todayIso;
  persist("financeiro");
  renderAll();
  toast("Status atualizado.");
 }
}

function renderSales() {
 const search = document.querySelector("#salesSearch").value.toLowerCase().trim();
 const sales = state.sales
  .filter((sale) => `${sale.description} ${sale.category} ${personName(sale.personId)}`.toLowerCase().includes(search))
  .sort((a, b) => b.saleDate.localeCompare(a.saleDate));

 document.querySelector("#salesTable").innerHTML = sales.length ?
   sales.map((sale) => saleRow(sale)).join("")
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
 if (!canAccessView("vendas") && !canAccessView("crm")) {
  toast("Acesso restrito para o seu perfil.");
  return;
 }
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
 if (!canAccessView("vendas") && !canAccessView("crm")) {
  toast("Acesso restrito para o seu perfil.");
  return;
 }
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
  <strong>Pr?via das parcelas</strong>
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
 deduplicateProjects(state);
 const search = document.querySelector("#projectSearch").value.toLowerCase().trim();
 const projects = state.projects
  .filter((project) => `${project.name} ${personName(project.customerId)} ${project.status}`.toLowerCase().includes(search))
  .sort((a, b) => a.name.localeCompare(b.name));

 document.querySelector("#projectList").innerHTML = projects.length ?
   projects.map((project) => `
   <article class="person-item">
    <strong><span>${escapeHtml(projectLabel(project))}</span><span>${projectStatusLabel(project.status)}</span></strong>
    <span class="muted">${escapeHtml(personName(project.customerId))} ? Centro: ${escapeHtml(costCenterName(project.costCenterId))}</span>
    <div class="row-actions">
     <button type="button" data-project-action="edit" data-id="${project.id}">Editar</button>
     <button type="button" data-project-action="view" data-id="${project.id}">Ver resultado</button>
    </div> ?
   </article>`).join("")
  : emptyMessage("Nenhum projeto cadastrado.");

 document.querySelectorAll("[data-project-action]").forEach((button) => {
  button.addEventListener("click", () => handleProjectAction(button.dataset.projectAction, button.dataset.id));
 });
 renderProjectDashboard();
}

function saveProject() {
 const id = els.projectId.value || crypto.randomUUID();
 const existing = state.projects.find((project) => project.id === id);
 const costCenterId = existing.costCenterId || crypto.randomUUID();
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
 document.querySelector(".project-toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
}

function hydrateProjectOptions() {
 const currentStockFilterProject = els.stockFilterProject.value || "";
 const projectOptions = state.projects.length ?
   state.projects.map((project) => `<option value="${project.id}">${escapeHtml(projectLabel(project))}</option>`).join("")
  : `<option value="">Cadastre um projeto primeiro</option>`;
 const optionalProjectOptions = `<option value="">Sem projeto</option>${projectOptions}`;

 els.transactionProject.innerHTML = projectOptions;
 els.saleProject.innerHTML = optionalProjectOptions;
 els.bankProject.innerHTML = optionalProjectOptions;
 refreshSearchableSelect(els.bankProject);
 els.projectReportSelect.innerHTML = optionalProjectOptions;
 els.invoiceProject.innerHTML = optionalProjectOptions;
 els.invoiceLinkProject.innerHTML = optionalProjectOptions;
 els.stockEntryProject.innerHTML = optionalProjectOptions;
 els.stockExitProject.innerHTML = optionalProjectOptions;
 els.stockFilterProject.innerHTML = optionalProjectOptions;
 if (currentStockFilterProject) els.stockFilterProject.value = currentStockFilterProject;
 refreshSearchableSelect(els.stockEntryProject);
 refreshSearchableSelect(els.stockExitProject);
 refreshSearchableSelect(els.stockFilterProject);
 els.installationProject.innerHTML = optionalProjectOptions;
 els.installationCustomer.innerHTML = `<option value="">Sem cliente vinculado</option>${state.people
  .filter((person) => person.type === "cliente" || person.type === "ambos")
  .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
  .join("")}`;
 const customerOptions = `<option value="">Sem cliente vinculado</option>${state.people
  .filter((person) => person.type === "cliente" || person.type === "ambos")
  .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
  .join("")}`;
 els.projectCustomer.innerHTML = customerOptions;
 els.quickProjectCustomer.innerHTML = customerOptions;
 refreshSearchableSelect(els.projectCustomer);
}

function projectLabel(project) {
 return project.name || project.code || "Projeto sem nome";
}

function projectStatusLabel(status) {
 return { ativo: "Ativo", orcamento: "Or?amento", homologacao: "Homologação", concluido: "Concluído", pausado: "Pausado" }[status] || status;
}

function projectStatusLabel(status) {
 const labels = {
  ativo: "Ativo",
  orcamento: "Orcamento",
  negociacao: "Em negociacao",
  contrato_assinado: "Contrato assinado",
  aguardando_documentacao: "Aguardando documentacao",
  homologacao: "Em homologacao",
  aguardando_instalacao: "Aguardando instalacao",
  instalacao_agendada: "Instalacao agendada",
  em_instalacao: "Em instalacao",
  aguardando_vistoria: "Aguardando vistoria",
  aguardando_faturamento: "Aguardando faturamento",
  liberado_instalacao: "Liberado para instalação",
  concluido: "Concluido",
  cancelado: "Cancelado",
  pausado: "Pausado",
 };
 return labels[status] || status || "Sem status";
}

function renderProjectDashboard() {
 const kpis = document.querySelector("#projectDashboardKpis");
 const table = document.querySelector("#projectDashboardTable");
 if (!kpis || !table) return;
 const rows = sortProjectDashboardRows(filteredProjectDashboardRows());
 renderProjectDashboardKpis(rows);
 renderProjectDashboardPanels(rows);
 renderProjectDashboardCharts(rows);
 renderProjectDashboardTable(rows);
}

function projectDashboardRows() {
 deduplicateProjects(state);
 return state.projects.map((project) => {
  const summary = projectSummary(project.id);
  const transactions = projectTransactions(project.id);
  const installation = latestProjectInstallation(project.id);
  const customer = state.people.find((person) => person.id === project.customerId);
  const city = project.city || customer.city || projectFieldFromNotes(project.notes, "cidade") || "";
  const responsible =
   project.responsible ||
   installation.team ||
   projectFieldFromNotes(project.notes, "responsavel") ||
   projectFieldFromNotes(project.notes, "responsavel tecnico") ||
   "";
  const execution = projectExecutionPercent(project, installation, summary);
  const priority = projectPriority(project, installation, summary);
  const health = projectHealthScore(project, installation, summary, execution);
  const daysToInstallation = installation.scheduledDate ? daysBetween(installation.scheduledDate, todayIso) : null;
  return {
   project,
   summary,
   customer,
   transactions,
   installation,
   city,
   responsible,
   execution,
   priority,
   health,
   daysToInstallation,
   financeSituation: projectFinancialSituation(summary, project),
   installSituation: projectInstallSituation(project, installation),
   costsOverBudget: projectCostsOverBudget(summary),
  };
 });
}

function filteredProjectDashboardRows() {
 return projectDashboardRows().filter(matchesProjectDashboardFilters);
}

function projectTransactions(projectId) {
 return state.transactions.filter((transaction) => transaction.projectId === projectId || transaction.costCenterId === projectId);
}

function latestProjectInstallation(projectId) {
 return state.installations
  .filter((installation) => installation.projectId === projectId)
  .sort((a, b) => (b.scheduledDate || b.createdAt || "").localeCompare(a.scheduledDate || a.createdAt || ""))[0];
}

function projectFieldFromNotes(notes, field) {
 if (!notes) return "";
 const normalized = field.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
 const match = String(notes).match(new RegExp(`${normalized}\\s*[:=-]\\s*([^\\n;]+)`, "i"));
 return match?.[1].trim() || "";
}

function projectExecutionPercent(project, installation, summary) {
 if (project.status === "concluido") return 100;
 if (installation.status === "concluida") return 100;
 if (["em_instalacao", "aguardando_vistoria"].includes(project.status) || installation.status === "em_execucao") return 75;
 if (["instalacao_agendada", "aguardando_instalacao"].includes(project.status) || installation.scheduledDate) return 55;
 if (["homologacao", "aguardando_documentacao"].includes(project.status)) return 35;
 if ((summary.invoiced || summary.contracted) > 0) return 20;
 return project.status === "orcamento" ? 10 : 0;
}

function projectPriority(project, installation, summary) {
 if (project.status === "cancelado") return "baixa";
 if (project.status === "pausado") return "media";
 if (isProjectInstallationLate(installation)) return "alta";
 if (summary.receivable > 0 && summary.received === 0 && (summary.invoiced || summary.contracted) > 0) return "alta";
 if (projectCostsOverBudget(summary)) return "alta";
 if (summary.payable > 0) return "media";
 return "baixa";
}

function projectHealthScore(project, installation, summary, execution) {
 let score = 100;
 if (summary.contracted > 0 && summary.marginPercent < (Number(project.minMargin) || 20)) score -= 24;
 if (summary.receivable > 0 && summary.received === 0 && summary.invoiced > 0) score -= 18;
 if (summary.payable > 0) score -= 10;
 if (projectCostsOverBudget(summary)) score -= 18;
 if (isProjectInstallationLate(installation)) score -= 18;
 if (project.status === "pausado") score -= 18;
 if (project.status === "cancelado") score = 0;
 if (project.status === "concluido" && execution === 100) score += 5;
 return Math.max(0, Math.min(100, Math.round(score)));
}

function projectCostsOverBudget(summary) {
 return summary.expectedCosts > 0 && summary.costs > summary.expectedCosts;
}

function isProjectInstallationLate(installation) {
 return Boolean(installation.scheduledDate && installation.scheduledDate < todayIso && installation.status !== "concluida");
}

function projectFinancialSituation(summary, project) {
 if (summary.receivable > 0 && summary.received === 0 && (summary.invoiced || summary.contracted) > 0) return "sem_recebimento";
 if (summary.receivable > 0) return "saldo_receber";
 if (summary.payable > 0) return "saldo_pagar";
 if (projectCostsOverBudget(summary)) return "custos_pendentes";
 if (summary.received > 0 || project.status === "concluido") return "em_dia";
 return "sem_movimento";
}

function projectInstallSituation(project, installation) {
 if (project.status === "homologacao") return "aguardando_homologacao";
 if (!installation) return "nao_iniciado";
 if (isProjectInstallationLate(installation)) return "atrasado";
 if (installation.status === "agendada") return "agendado";
 if (installation.status === "em_execucao") return "em_execucao";
 if (installation.status === "concluida") return "concluido";
 return "nao_iniciado";
}

function normalizeText(value) {
 return String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .trim();
}

function formatCurrency(value) {
 return money(value);
}

function formatPercent(value) {
 return `${Number(value || 0).toFixed(1).replace(".", ",")}%`;
}

function isoDate(date) {
 return toIso(date);
}

function matchesProjectDashboardFilters(row) {
 const status = document.querySelector("#projectFilterStatus").value || "todos";
 const finance = document.querySelector("#projectFilterFinance").value || "todos";
 const install = document.querySelector("#projectFilterInstall").value || "todos";
 const period = document.querySelector("#projectFilterPeriod").value || "todos";
 const dateField = document.querySelector("#projectFilterDateField").value || "inicio";
 const valueFilter = document.querySelector("#projectFilterValue").value || "todos";
 const client = normalizeText(document.querySelector("#projectFilterClient").value || "");
 const city = normalizeText(document.querySelector("#projectFilterCity").value || "");
 const responsible = normalizeText(document.querySelector("#projectFilterResponsible").value || "");

 if (status !== "todos" && row.project.status !== status) return false;
 if (finance !== "todos") {
  const hasOverdueReceivable = row.transactions.some((item) => item.type === "receber" && isOverdue(item));
  const receivingOk = row.summary.receivable === 0 && row.summary.received > 0;
  const lowMargin = row.summary.contracted > 0 && row.summary.marginPercent < (Number(row.project.minMargin) || 20);
  const financeMatches = {
   parcelas_vencidas: hasOverdueReceivable,
   recebimento_em_dia: receivingOk,
   pagamentos_pendentes: row.summary.payable > 0,
   custos_pendentes: row.costsOverBudget,
   lucro_negativo: row.summary.expectedResult < 0,
   margem_abaixo_meta: lowMargin,
   saldo_receber: row.financeSituation === "saldo_receber",
   saldo_pagar: row.financeSituation === "saldo_pagar",
   sem_recebimento: row.financeSituation === "sem_recebimento",
   em_dia: row.financeSituation === "em_dia",
  };
  if (!financeMatches[finance]) return false;
 }
 if (install !== "todos") {
  const installMatches = {
   nao_iniciado: row.installSituation === "nao_iniciado",
   prioridade_alta: row.priority === "alta",
   prioridade_media: row.priority === "media",
   prioridade_baixa: row.priority === "baixa",
   em_andamento: row.installSituation === "em_execucao",
   atrasado: row.installSituation === "atrasado",
   finalizado: row.installSituation === "concluido",
   agendado: row.installSituation === "agendado",
   concluido: row.installSituation === "concluido",
  };
  if (!installMatches[install]) return false;
 }
 if (!matchesProjectPeriod(row, period, dateField)) return false;
 if (!matchesProjectValueFilter(row.summary.contracted || row.summary.invoiced || 0, valueFilter)) return false;
 if (client && !normalizeText(personName(row.project.customerId)).includes(client)) return false;
 if (city && !normalizeText(row.city).includes(city)) return false;
 if (responsible && !normalizeText(row.responsible).includes(responsible)) return false;
 return true;
}

function matchesProjectValueFilter(amount, filter) {
 if (filter === "todos") return true;
 if (filter === "ate_20000") return amount <= 20000;
 if (filter === "20000_50000") return amount > 20000 && amount <= 50000;
 if (filter === "50000_100000") return amount > 50000 && amount <= 100000;
 if (filter === "100000_300000") return amount > 100000 && amount <= 300000;
 if (filter === "acima_300000") return amount > 300000;
 if (filter === "ate_50") return amount <= 50000;
 if (filter === "50_100") return amount > 50000 && amount <= 100000;
 if (filter === "100_300") return amount > 100000 && amount <= 300000;
 if (filter === "acima_300") return amount > 300000;
 return true;
}

function matchesProjectPeriod(row, period, dateField) {
 if (period === "todos") return true;
 const date = projectFilterDate(row, dateField);
 if (!date) return false;
 const range = projectPeriodRange(period);
 return date >= range.start && date <= range.end;
}

function projectFilterDate(row, dateField) {
 if (dateField === "sale") return row.project.saleDate || row.project.contractDate || row.project.startDate || "";
 if (dateField === "installation") return row.installation.scheduledDate || row.project.endDate || "";
 if (dateField === "conclusion") return row.installation.completedDate || row.project.completedDate || "";
 if (dateField === "contrato") return row.project.contractDate || row.project.startDate || "";
 if (dateField === "homologacao") return row.project.homologationDate || row.project.startDate || "";
 if (dateField === "instalacao") return row.installation.scheduledDate || row.project.endDate || "";
 if (dateField === "previsao") return row.project.endDate || row.installation.scheduledDate || "";
 return row.project.startDate || row.project.createdAt || "";
}

function projectPeriodRange(period) {
 const now = new Date(todayIso + "T00:00:00");
 if (period === "hoje") return { start: todayIso, end: todayIso };
 if (period === "ontem") {
  const yesterday = isoDate(addDays(now, -1));
  return { start: yesterday, end: yesterday };
 }
 if (period === "7dias") return { start: isoDate(addDays(now, -6)), end: todayIso };
 if (period === "30dias") return { start: isoDate(addDays(now, -29)), end: todayIso };
 if (period === "mes_atual") return { start: todayIso.slice(0, 8) + "01", end: todayIso };
 if (period === "mes_anterior" || period === "mes_passado") {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return { start: isoDate(start), end: isoDate(end) };
 }
 if (period === "trimestre") {
  const quarterStart = Math.floor(now.getMonth() / 3) * 3;
  return { start: isoDate(new Date(now.getFullYear(), quarterStart, 1)), end: todayIso };
 }
 if (period === "ano") return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
 return { start: "1900-01-01", end: "2999-12-31" };
}

function sortProjectDashboardRows(rows) {
 const sort = document.querySelector("#projectSort").value || "nome";
 const sorted = [...rows];
 const value = {
  nome: (row) => normalizeText(projectLabel(row.project)),
  maior_receita: (row) => row.summary.contracted || row.summary.invoiced || 0,
  menor_receita: (row) => -(row.summary.contracted || row.summary.invoiced || 0),
  maior_lucro: (row) => row.summary.expectedResult || 0,
  menor_lucro: (row) => -(row.summary.expectedResult || 0),
  maior_custo: (row) => row.summary.costs || 0,
  menor_custo: (row) => -(row.summary.costs || 0),
  maior_margem: (row) => row.summary.marginPercent || 0,
  menor_margem: (row) => -(row.summary.marginPercent || 0),
  mais_recente: (row) => {
   const date = projectFilterDate(row, "sale") || row.project.createdAt || "";
   return date ? parseDate(date.slice(0, 10)).getTime() : 0;
  },
  mais_antigo: (row) => {
   const date = projectFilterDate(row, "sale") || row.project.createdAt || "";
   return date ? -parseDate(date).getTime() : 0;
  },
  maior_prioridade: (row) => ({ alta: 3, media: 2, baixa: 1 }[row.priority] || 0),
  maior_execucao: (row) => row.execution,
  valor_desc: (row) => row.summary.contracted || row.summary.invoiced || 0,
  margem_desc: (row) => row.summary.marginPercent || 0,
  lucro_desc: (row) => row.summary.expectedResult || 0,
  mais_atrasado: (row) => (row.daysToInstallation === null ? -9999 : -row.daysToInstallation),
  saude_desc: (row) => row.health,
 }[sort];
 sorted.sort((a, b) => {
  const aValue = value(a);
  const bValue = value(b);
  if (typeof aValue === "string") return aValue.localeCompare(bValue);
  return bValue - aValue;
 });
 return sorted;
}

function renderProjectDashboardKpis(rows) {
 const totals = rows.reduce(
  (acc, row) => {
   acc.projects += 1;
   acc.contracted += row.summary.contracted || row.summary.invoiced || 0;
   acc.received += row.summary.received;
   acc.receivable += row.summary.receivable;
   acc.costs += row.summary.costs;
   acc.expectedResult += row.summary.expectedResult;
   acc.realizedResult += row.summary.realizedResult;
   acc.late += row.installSituation === "atrasado" ? 1 : 0;
   acc.lowMargin += row.summary.contracted > 0 && row.summary.marginPercent < (Number(row.project.minMargin) || 20) ? 1 : 0;
   acc.health += row.health;
   return acc;
  },
  { projects: 0, contracted: 0, received: 0, receivable: 0, costs: 0, expectedResult: 0, realizedResult: 0, late: 0, lowMargin: 0, health: 0 }
 );
 const avgMargin = totals.contracted ? ((totals.expectedResult / totals.contracted) * 100) : 0;
 const avgHealth = totals.projects ? totals.health / totals.projects : 0;
 document.querySelector("#projectDashboardKpis").innerHTML = [
  projectKpiCard("Projetos filtrados", totals.projects, "Carteira conforme filtros"),
  projectKpiCard("Receita contratada", formatCurrency(totals.contracted), "Valor total vendido"),
  projectKpiCard("Receita recebida", formatCurrency(totals.received), `${formatCurrency(totals.receivable)} a receber`),
  projectKpiCard("Custos realizados", formatCurrency(totals.costs), "Custos diretos vinculados"),
  projectKpiCard("Resultado previsto", formatCurrency(totals.expectedResult), `Margem media ${formatPercent(avgMargin)}`),
  projectKpiCard("Resultado realizado", formatCurrency(totals.realizedResult), "Recebido menos custos pagos"),
  projectKpiCard("Projetos atrasados", totals.late, "Instalacao ou prazo vencido", totals.late ? "danger" : "ok"),
  projectKpiCard("Saude media", `${avgHealth.toFixed(0)}%`, `${totals.lowMargin} com margem baixa`, avgHealth < 65 ? "danger" : avgHealth < 80 ? "warn" : "ok"),
 ].join("");
}

function projectKpiCard(label, value, hint, tone = "") {
 return `<article class="project-mini-kpi ${tone}">
  <span>${escapeHtml(label)}</span>
  <strong>${escapeHtml(String(value))}</strong>
  <small>${escapeHtml(hint)}</small>
 </article>`;
}

function renderProjectDashboardPanels(rows) {
 const highPriority = rows.filter((row) => row.priority === "alta").length;
 const waitingHomologation = rows.filter((row) => row.installSituation === "aguardando_homologacao").length;
 const waitingInstall = rows.filter((row) => ["nao_iniciado", "agendado"].includes(row.installSituation)).length;
 const late = rows.filter((row) => row.installSituation === "atrasado").length;
 const payable = rows.reduce((sum, row) => sum + row.summary.payable, 0);
 const receivable = rows.reduce((sum, row) => sum + row.summary.receivable, 0);
 const topRevenue = [...rows].sort((a, b) => (b.summary.invoiced || b.summary.contracted) - (a.summary.invoiced || a.summary.contracted))[0];
 const lowMargin = rows.filter((row) => row.summary.contracted > 0 && row.summary.marginPercent < (Number(row.project.minMargin) || 20)).length;
 document.querySelector("#projectSupervisorChips").innerHTML = [
  projectChip("Prioridade alta", highPriority, highPriority ? "danger" : "ok"),
  projectChip("Aguardando homologacao", waitingHomologation, waitingHomologation ? "warn" : "ok"),
  projectChip("Aguardando instalacao", waitingInstall, waitingInstall ? "warn" : "ok"),
  projectChip("Atrasados", late, late ? "danger" : "ok"),
 ].join("");
 document.querySelector("#projectFinanceChips").innerHTML = [
  projectChip("A receber", formatCurrency(receivable), receivable ? "warn" : "ok"),
  projectChip("A pagar", formatCurrency(payable), payable ? "warn" : "ok"),
  projectChip("Margem baixa", lowMargin, lowMargin ? "danger" : "ok"),
  projectChip("Maior faturamento", topRevenue ? projectLabel(topRevenue.project) : "-", "neutral"),
 ].join("");
}

function projectChip(label, value, tone) {
 return `<div class="project-chip ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function renderProjectDashboardCharts(rows) {
 const topRevenue = [...rows].sort((a, b) => (b.summary.contracted || b.summary.invoiced) - (a.summary.contracted || a.summary.invoiced)).slice(0, 6);
 const topProfit = [...rows].sort((a, b) => b.summary.expectedResult - a.summary.expectedResult).slice(0, 6);
 const topMargin = [...rows].filter((row) => row.summary.contracted > 0).sort((a, b) => b.summary.marginPercent - a.summary.marginPercent).slice(0, 6);
 const topCost = [...rows].sort((a, b) => b.summary.costs - a.summary.costs).slice(0, 6);
 renderProjectBars("#projectRevenueChart", topRevenue, (row) => row.summary.contracted || row.summary.invoiced, formatCurrency);
 renderProjectBars("#projectProfitChart", topProfit, (row) => row.summary.expectedResult, formatCurrency);
 renderProjectBars("#projectMarginChart", topMargin, (row) => row.summary.marginPercent, (value) => formatPercent(value));
 renderProjectBars("#projectCostChart", topCost, (row) => row.summary.costs, formatCurrency);
}

function renderProjectBars(selector, rows, valueGetter, formatter) {
 const container = document.querySelector(selector);
 if (!container) return;
 const max = Math.max(...rows.map(valueGetter).map((value) => Math.abs(value)), 1);
 container.innerHTML = rows.length ?
   rows.map((row) => {
    const value = valueGetter(row);
    const width = Math.max(4, Math.min(100, Math.abs(value) / max * 100));
    return `<button type="button" class="project-bar-row" data-project-id="${row.project.id}">
     <span>${escapeHtml(projectLabel(row.project))}</span>
     <div class="project-bar-track"><i style="width:${width}%"></i></div>
     <strong>${escapeHtml(formatter(value))}</strong>
    </button>`;
   }).join("")
  : emptyMessage("Sem dados para exibir.");
 container.querySelectorAll("[data-project-id]").forEach((button) => {
  button.addEventListener("click", () => openProjectDrawer(button.dataset.projectId));
 });
}

function renderProjectDashboardTable(rows) {
 document.querySelector("#projectDashboardTable").innerHTML = rows.length ?
   rows.map((row) => `<tr class="project-dashboard-row" data-project-id="${row.project.id}">
   <td>
    <strong>${escapeHtml(projectLabel(row.project))}</strong>
   </td>
   <td>${escapeHtml(personName(row.project.customerId))}</td>
   <td>${escapeHtml(row.city || "-")}</td>
   <td>${escapeHtml(row.responsible || "-")}</td>
   <td>${formatCurrency(row.summary.contracted || row.summary.invoiced)}</td>
   <td>${formatCurrency(row.summary.received)}</td>
   <td>${formatCurrency(row.summary.receivable)}</td>
   <td>${formatCurrency(row.summary.expectedCosts)}</td>
   <td>${formatCurrency(row.summary.costs)}</td>
   <td>${formatCurrency(row.summary.expectedResult)}</td>
   <td>${formatPercent(row.summary.marginPercent)}</td>
   <td>
    <div class="project-progress"><i style="width:${row.execution}%"></i></div>
    <small>${row.execution}%</small>
   </td>
   <td>${projectBadge(projectInstallLabel(row.installSituation), installTone(row.installSituation))}</td>
   <td>${projectBadge(projectStatusLabel(row.project.status), statusTone(row.project.status))}</td>
   <td>${projectBadge(priorityLabel(row.priority), priorityTone(row.priority))}</td>
   <td><strong>${row.health}%</strong></td>
   <td>${formatDate((row.project.updatedAt || row.project.createdAt || "").slice(0, 10))}</td> ?
  </tr>`).join("")
  : `<tr><td colspan="17">${emptyMessage("Nenhum projeto encontrado com os filtros atuais.")}</td></tr>`;
 document.querySelectorAll(".project-dashboard-row").forEach((row) => {
  row.addEventListener("click", () => openProjectDrawer(row.dataset.projectId));
 });
}

function projectBadge(label, tone = "neutral") {
 return `<span class="project-badge ${tone}">${escapeHtml(label)}</span>`;
}

function statusTone(status) {
 if (["concluido", "liberado_instalacao"].includes(status)) return "ok";
 if (["cancelado", "pausado"].includes(status)) return "danger";
 if (["instalacao_agendada", "em_instalacao", "homologacao"].includes(status)) return "warn";
 return "neutral";
}

function priorityTone(priority) {
 if (priority === "alta") return "danger";
 if (priority === "media") return "warn";
 return "ok";
}

function priorityLabel(priority) {
 return { alta: "Alta", media: "Media", baixa: "Baixa" }[priority] || "Baixa";
}

function projectInstallLabel(situation) {
 return {
  aguardando_homologacao: "Aguardando homologacao",
  nao_iniciado: "Nao iniciado",
  atrasado: "Atrasado",
  agendado: "Agendado",
  em_execucao: "Em andamento",
  concluido: "Finalizado",
 }[situation] || situation || "-";
}

function installTone(situation) {
 if (situation === "concluido") return "ok";
 if (situation === "atrasado") return "danger";
 if (["agendado", "em_execucao", "aguardando_homologacao"].includes(situation)) return "warn";
 return "neutral";
}

function clearProjectDashboardFilters() {
 ["#projectFilterClient", "#projectFilterCity", "#projectFilterResponsible"].forEach((selector) => {
  const field = document.querySelector(selector);
  if (field) field.value = "";
 });
 [
  ["#projectFilterStatus", "todos"],
  ["#projectFilterFinance", "todos"],
  ["#projectFilterInstall", "todos"],
  ["#projectFilterPeriod", "todos"],
  ["#projectFilterDateField", "inicio"],
  ["#projectFilterValue", "todos"],
  ["#projectSort", "nome"],
 ].forEach(([selector, value]) => {
  const field = document.querySelector(selector);
  if (field) field.value = value;
 });
 renderProjectDashboard();
}

function exportProjectDashboardCsv() {
 const rows = filteredProjectDashboardRows();
 const headers = ["Projeto", "Cliente", "Status", "Responsavel", "Cidade", "Receita contratada", "Receita recebida", "Custos", "Resultado previsto", "Margem", "Execucao", "Prioridade", "Saude"];
 const csvRows = rows.map((row) => [
  projectLabel(row.project),
  personName(row.project.customerId),
  projectStatusLabel(row.project.status),
  row.responsible,
  row.city,
  row.summary.contracted || row.summary.invoiced,
  row.summary.received,
  row.summary.costs,
  row.summary.expectedResult,
  row.summary.marginPercent,
  row.execution,
  priorityLabel(row.priority),
  row.health,
 ]);
 downloadCsv(`projetos-dashboard-${todayIso}.csv`, [headers, ...csvRows]);
}

function openProjectDrawer(projectId) {
 const row = projectDashboardRows().find((item) => item.project.id === projectId);
 const drawer = document.querySelector("#projectDrawer");
 const content = document.querySelector("#projectDrawerContent");
 if (!row || !drawer || !content) return;
 content.innerHTML = `
  <div class="drawer-header">
   <div>
    <small>${escapeHtml(personName(row.project.customerId))}</small>
    <h3 id="projectDrawerTitle">${escapeHtml(projectLabel(row.project))}</h3>
   </div>
   ${projectBadge(priorityLabel(row.priority), priorityTone(row.priority))}
  </div>
  <div class="drawer-grid">
   ${drawerMetric("Receita contratada", formatCurrency(row.summary.contracted || row.summary.invoiced))}
   ${drawerMetric("Recebido", formatCurrency(row.summary.received))}
   ${drawerMetric("A receber", formatCurrency(row.summary.receivable))}
   ${drawerMetric("Custos", formatCurrency(row.summary.costs))}
   ${drawerMetric("Resultado previsto", formatCurrency(row.summary.expectedResult))}
   ${drawerMetric("Saude", `${row.health}%`)}
  </div>
  ${drawerSection("Dados do projeto", [
   ["Status", projectStatusLabel(row.project.status)],
   ["Responsavel", row.responsible || "-"],
   ["Cidade", row.city || "-"],
   ["Inicio", formatDate(row.project.startDate)],
   ["Previsao", formatDate(row.project.endDate)],
   ["Centro de custo", costCenterName(row.project.costCenterId)],
  ])}
  ${drawerSection("Instalacao", [
   ["Situacao", row.installation ? statusLabel(row.installation.status) : "Nao programada"],
   ["Data prevista", formatDate(row.installation.scheduledDate)],
   ["Equipe", row.installation.team || "-"],
   ["Conclusao", formatDate(row.installation.completedDate)],
  ])}
  ${drawerList("Lancamentos financeiros", row.transactions.slice(0, 8).map((transaction) =>
   `${formatDate(transaction.dueDate)} - ${transaction.type === "receber" ? "Receber" : "Pagar"} - ${formatCurrency(accountingValueOf(transaction))} - ${statusLabel(transaction.status)}`
  ))}
  ${protocolProjectSectionHtml(row.project.id)}
 `;
 drawer.classList.add("open");
 drawer.setAttribute("aria-hidden", "false");
 document.querySelectorAll("[data-open-protocol]").forEach((button) => {
  button.addEventListener("click", () => {
   closeProjectDrawer();
   openProtocolDrawer(button.dataset.openProtocol);
  });
 });
}

function drawerMetric(label, value) {
 return `<article class="drawer-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function drawerSection(title, rows) {
 return `<section class="drawer-section"><h4>${escapeHtml(title)}</h4>${rows.map(([label, value]) =>
  `<p><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || "-"))}</strong></p>`
 ).join("")}</section>`;
}

function drawerList(title, rows) {
 return `<section class="drawer-section"><h4>${escapeHtml(title)}</h4>${rows.length ? rows.map((row) => `<p>${escapeHtml(row)}</p>`).join("") : `<p>${emptyMessage("Sem lancamentos vinculados.")}</p>`}</section>`;
}

function closeProjectDrawer() {
 const drawer = document.querySelector("#projectDrawer");
 if (!drawer) return;
 drawer.classList.remove("open");
 drawer.setAttribute("aria-hidden", "true");
}

function costCenterName(costCenterId) {
 return state.costCenters.find((item) => item.id === costCenterId)?.name || "Não criado";
}

// ===================== Central de Protocolos e Concession?rias =====================

function hydrateProtocolOptions() {
 const utilityOptions = state.utilityCompanies
  .filter((item) => item.active !== false)
  .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
  .join("");
 const activityTypeOptions = state.protocolActivityTypes
  .filter((item) => item.active !== false)
  .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
  .join("");
 const projectOptions = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(projectLabel(project))}</option>`).join("");
 const customerOptions = state.people
  .filter((person) => person.type === "cliente" || person.type === "ambos")
  .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
  .join("");
 const responsibleOptions = state.users
  .filter((user) => user.active)
  .map((user) => `<option value="${user.id}">${escapeHtml(user.name || user.username)}</option>`)
  .join("");
 const statusOptions = PROTOCOL_STATUSES.map((status) => `<option value="${status.id}">${escapeHtml(status.label)}</option>`).join("");

 if (els.protocolUtility) setSelectOptions(els.protocolUtility, utilityOptions);
 if (els.protocolActivityType) setSelectOptions(els.protocolActivityType, activityTypeOptions);
 if (els.protocolProject) setSelectOptions(els.protocolProject, `<option value="">Nenhum (sem projeto)</option>${projectOptions}`);
 if (els.protocolCustomer) setSelectOptions(els.protocolCustomer, customerOptions || `<option value="">Cadastre um cliente primeiro</option>`);
 if (els.protocolResponsible) setSelectOptions(els.protocolResponsible, `<option value="">Sem respons?vel</option>${responsibleOptions}`);
 if (els.protocolStatus) setSelectOptions(els.protocolStatus, statusOptions);

 if (els.protocolFilterUtility) setSelectOptions(els.protocolFilterUtility, `<option value="todos">Todas</option>${utilityOptions}`);
 if (els.protocolFilterActivityType) setSelectOptions(els.protocolFilterActivityType, `<option value="todos">Todos</option>${activityTypeOptions}`);
 if (els.protocolFilterStatus) setSelectOptions(els.protocolFilterStatus, `<option value="todos">Todos</option>${statusOptions}`);
 if (els.protocolFilterResponsible) setSelectOptions(els.protocolFilterResponsible, `<option value="todos">Todos</option>${responsibleOptions}`);
 if (els.protocolFilterProject) setSelectOptions(els.protocolFilterProject, `<option value="todos">Todos</option><option value="com">Com projeto</option><option value="sem">Sem projeto</option>${projectOptions}`);
}

function protocolStatusInfo(statusId) {
 return PROTOCOL_STATUSES.find((status) => status.id === statusId) || PROTOCOL_STATUSES[0];
}

function protocolStatusLabel(statusId) {
 return protocolStatusInfo(statusId).label;
}

function utilityCompanyName(id) {
 return state.utilityCompanies.find((item) => item.id === id)?.name || "Não informado";
}

function activityTypeName(id) {
 return state.protocolActivityTypes.find((item) => item.id === id)?.name || "Não informado";
}

function userName(id) {
 const user = state.users.find((item) => item.id === id);
 return user ? (user.name || user.username) : "Sem respons?vel";
}

function nextProtocolInternalNumber() {
 return `PRT-${String(state.protocols.length + 1).padStart(4, "0")}`;
}

function checklistStatusLabel(status) {
 return { pendente: "Pendente", enviado: "Enviado", aprovado: "Aprovado", rejeitado: "Rejeitado" }[status] || status;
}

function protocolIsOpen(protocol) {
 return !PROTOCOL_CLOSED_STATUSES.includes(protocol.status);
}

function protocolDaysRemaining(protocol) {
 if (!protocol.utilityDeadline || !protocolIsOpen(protocol)) return null;
 return daysBetween(protocol.utilityDeadline, todayIso);
}

function protocolDeadlineInfo(protocol) {
 const daysRemaining = protocolDaysRemaining(protocol);
 if (daysRemaining === null) return { tone: "neutral", label: "Sem prazo" };
 if (daysRemaining < 0) return { tone: "danger", label: `Vencido h? ${Math.abs(daysRemaining)} dia(s)` };
 if (daysRemaining === 0) return { tone: "danger", label: "Vence hoje" };
 if (daysRemaining <= 7) return { tone: "warn", label: `Vence em ${daysRemaining} dia(s)` };
 return { tone: "ok", label: `Faltam ${daysRemaining} dia(s)` };
}

function matchesProtocolFilters(protocol) {
 const search = normalizeText(els.protocolSearch.value || "");
 const utility = els.protocolFilterUtility.value || "todos";
 const activityType = els.protocolFilterActivityType.value || "todos";
 const status = els.protocolFilterStatus.value || "todos";
 const responsible = els.protocolFilterResponsible.value || "todos";
 const city = normalizeText(els.protocolFilterCity.value || "");
 const projectFilter = els.protocolFilterProject.value || "todos";
 const deadlineFilter = els.protocolFilterDeadline.value || "todos";
 const priorityFilter = els.protocolFilterPriority.value || "todos";
 const period = els.protocolFilterPeriod.value || "todos";

 if (period !== "todos" && !matchesProtocolPeriod(protocol, period)) return false;
 if (utility !== "todos" && protocol.utilityCompanyId !== utility) return false;
 if (activityType !== "todos" && protocol.activityTypeId !== activityType) return false;
 if (status !== "todos" && protocol.status !== status) return false;
 if (responsible !== "todos" && protocol.responsibleUserId !== responsible) return false;
 if (city && !normalizeText(protocol.city).includes(city)) return false;
 if (priorityFilter !== "todos" && protocol.priority !== priorityFilter) return false;
 if (projectFilter === "com" && !protocol.projectId) return false;
 if (projectFilter === "sem" && protocol.projectId) return false;
 if (!["todos", "com", "sem"].includes(projectFilter) && protocol.projectId !== projectFilter) return false;
 if (deadlineFilter !== "todos") {
  const daysRemaining = protocolDaysRemaining(protocol);
  if (deadlineFilter === "atraso" && !(daysRemaining !== null && daysRemaining < 0)) return false;
  if (deadlineFilter === "hoje" && daysRemaining !== 0) return false;
  if (deadlineFilter === "semana" && !(daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 7)) return false;
  if (deadlineFilter === "dentro" && !(daysRemaining !== null && daysRemaining > 7)) return false;
 }
 if (search) {
  const haystack = normalizeText([
   personName(protocol.customerId),
   protocol.protocolNumber,
   protocol.internalNumber,
   protocol.consumerUnit,
   protocol.city,
  ].join(" "));
  if (!haystack.includes(search)) return false;
 }
 return true;
}

function matchesProtocolPeriod(protocol, period) {
 if (!protocol.openedAt) return false;
 const range = projectPeriodRange(period);
 return protocol.openedAt >= range.start && protocol.openedAt <= range.end;
}

function filteredProtocols() {
 return state.protocols
  .filter(matchesProtocolFilters)
  .sort((a, b) => (a.utilityDeadline || "9999-99-99").localeCompare(b.utilityDeadline || "9999-99-99"));
}

function renderProtocols() {
 hydrateProtocolOptions();
 const rows = filteredProtocols();
 els.protocolsTable.innerHTML = rows.length ?
   rows.map(protocolRow).join("")
  : `<tr><td colspan="10">${emptyMessage("Nenhum protocolo encontrado com os filtros atuais.")}</td></tr>`;
 document.querySelectorAll("[data-protocol-open]").forEach((row) => {
  row.addEventListener("click", () => openProtocolDrawer(row.dataset.protocolOpen));
 });
 renderProtocolKanban(rows);
 renderProtocolKpis();
 renderProtocolAlerts();
}

let currentProtocolTab = "tabela";

function setProtocolTab(tab) {
 currentProtocolTab = tab;
 document.querySelectorAll("[data-protocol-tab]").forEach((button) => {
  button.classList.toggle("active", button.dataset.protocolTab === tab);
 });
 document.querySelectorAll("[data-protocol-panel]").forEach((panel) => {
  panel.classList.toggle("hidden", panel.dataset.protocolPanel !== tab);
 });
}

function computeProtocolKpis() {
 const all = state.protocols;
 const period = els.protocolFilterPeriod.value || "todos";
 const totalInPeriod = period === "todos" ? all.length : all.filter((p) => matchesProtocolPeriod(p, period)).length;
 const open = all.filter(protocolIsOpen);
 const overdue = open.filter((p) => { const d = protocolDaysRemaining(p); return d !== null && d < 0; });
 const dueThisWeek = open.filter((p) => { const d = protocolDaysRemaining(p); return d !== null && d >= 0 && d <= 7; });
 const homologacoes = open.filter((p) => p.activityTypeId === "homologacao");
 const viabilidade = open.filter((p) => p.activityTypeId === "consulta_viabilidade");
 const aguardandoCliente = all.filter((p) => p.status === "aguardando_cliente");
 const aguardandoConcessionaria = all.filter((p) => p.status === "aguardando_concessionaria");
 const projetosLiberados = all.filter((p) => p.status === PROTOCOL_RELEASE_STATUS && p.projectId);
 const projetosConcluidos = all.filter((p) => p.status === "concluido" && p.projectId);

 const approvalStatuses = ["projeto_aprovado", "instalacao_liberada", "concluido"];
 const approvalDurations = [];
 all.forEach((protocol) => {
  if (!protocol.openedAt) return;
  const milestone = state.protocolHistory
   .filter((item) => item.protocolId === protocol.id && approvalStatuses.includes(item.toStatus))
   .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (milestone) approvalDurations.push(daysBetween(milestone.createdAt.slice(0, 10), protocol.openedAt));
 });
 const avgApprovalDays = approvalDurations.length ?
   Math.round(approvalDurations.reduce((sum, value) => sum + value, 0) / approvalDurations.length)
  : null;

 return {
  totalInPeriod,
  open: open.length,
  overdue: overdue.length,
  dueThisWeek: dueThisWeek.length,
  homologacoes: homologacoes.length,
  viabilidade: viabilidade.length,
  aguardandoCliente: aguardandoCliente.length,
  aguardandoConcessionaria: aguardandoConcessionaria.length,
  projetosLiberados: projetosLiberados.length,
  projetosConcluidos: projetosConcluidos.length,
  avgApprovalDays,
 };
}

function renderProtocolKpis() {
 const container = document.querySelector("#protocolKpis");
 if (!container) return;
 const kpis = computeProtocolKpis();
 container.innerHTML = [
  projectKpiCard("Protocolos no per?odo", kpis.totalInPeriod, "Todos os status, inclusive concluídos"),
  projectKpiCard("Tickets abertos", kpis.open, "Em andamento agora"),
  projectKpiCard("Tickets em atraso", kpis.overdue, "Prazo da concession?ria vencido", kpis.overdue ? "danger" : "ok"),
  projectKpiCard("Tickets desta semana", kpis.dueThisWeek, "Vencem nos pr?ximos 7 dias", kpis.dueThisWeek ? "warn" : "ok"),
  projectKpiCard("Homologaúes em andamento", kpis.homologacoes, "Tipo: Homologação"),
  projectKpiCard("Consultas de viabilidade", kpis.viabilidade, "Tipo: Consulta de viabilidade"),
  projectKpiCard("Aguardando cliente", kpis.aguardandoCliente, "Ticket parado por resposta do cliente", kpis.aguardandoCliente ? "warn" : "ok"),
  projectKpiCard("Aguardando concession?ria", kpis.aguardandoConcessionaria, "Ticket parado na concession?ria", kpis.aguardandoConcessionaria ? "warn" : "ok"),
  projectKpiCard("Projetos liberados", kpis.projetosLiberados, "Protocolos que liberaram instalação"),
  projectKpiCard("Projetos concluídos", kpis.projetosConcluidos, "Protocolos concluídos com projeto vinculado"),
  projectKpiCard("Tempo m?dio de aprovação", kpis.avgApprovalDays === null ? "-" : `${kpis.avgApprovalDays} dia(s)`, "Da abertura até aprovação/liberação"),
 ].join("");
}

function computeProtocolAlerts() {
 const open = state.protocols.filter(protocolIsOpen);
 return {
  vencidos: open.filter((p) => { const d = protocolDaysRemaining(p); return d !== null && d < 0; }),
  venceHoje: open.filter((p) => protocolDaysRemaining(p) === 0),
  venceAmanha: open.filter((p) => protocolDaysRemaining(p) === 1),
  aguardandoCliente: open.filter((p) => p.status === "aguardando_cliente"),
  aguardandoDocumentos: open.filter((p) => p.status === "aguardando_documentos"),
  paradoHaMuitosDias: open.filter((p) => {
   const ref = (p.lastMovementAt || p.updatedAt || p.createdAt || "").slice(0, 10);
   return ref && daysBetween(todayIso, ref) > PROTOCOL_STALE_DAYS;
  }),
 };
}

function renderProtocolAlerts() {
 const container = document.querySelector("#protocolAlerts");
 if (!container) return;
 const alerts = computeProtocolAlerts();
 container.innerHTML = PROTOCOL_ALERT_CATEGORIES.map((category) => {
  const count = alerts[category.key].length;
  return `<button type="button" class="project-chip ${count ? "danger" : "ok"}" data-protocol-alert="${category.key}">
   <span>${escapeHtml(category.label)}</span>
   <strong>${count}</strong>
  </button>`;
 }).join("");
 document.querySelectorAll("[data-protocol-alert]").forEach((button) => {
  button.addEventListener("click", () => {
   const category = PROTOCOL_ALERT_CATEGORIES.find((item) => item.key === button.dataset.protocolAlert);
   clearProtocolFilters();
   category.apply();
   setProtocolTab("tabela");
   renderProtocols();
  });
 });
}

function renderProtocolKanban(rows) {
 const board = document.querySelector("#protocolKanbanBoard");
 if (!board) return;
 board.innerHTML = PROTOCOL_STATUSES.map((status) => protocolKanbanColumn(status, rows)).join("");
 bindProtocolKanbanEvents();
}

function protocolKanbanColumn(status, rows) {
 const items = rows.filter((protocol) => protocol.status === status.id);
 return `
  <section class="kanban-column" data-protocol-status="${status.id}">
   <header class="kanban-head">
    <strong>${escapeHtml(status.label)}</strong>
    <span>${items.length} ticket(s)</span>
   </header>
   <div class="kanban-cards" data-protocol-drop-status="${status.id}">
    ${items.slice(0, 60).map(protocolKanbanCard).join("")}
    ${items.length > 60 ? `<div class="muted kanban-limit">Mostrando 60 de ${items.length}</div>` : ""}
   </div>
  </section>`;
}

function protocolKanbanCard(protocol) {
 const deadline = protocolDeadlineInfo(protocol);
 return `
  <article class="opportunity-card" draggable="true" data-protocol-id="${protocol.id}">
   <strong>${escapeHtml(personName(protocol.customerId))}</strong>
   <span class="muted">${escapeHtml(utilityCompanyName(protocol.utilityCompanyId))} ? ${escapeHtml(activityTypeName(protocol.activityTypeId))}</span>
   <span class="muted">${protocol.projectId ? escapeHtml(projectName(protocol.projectId)) : "Sem projeto"}</span>
   ${projectBadge(deadline.label, deadline.tone)}
  </article>`;
}

function bindProtocolKanbanEvents() {
 document.querySelectorAll("#protocolKanbanBoard .opportunity-card").forEach((card) => {
  card.addEventListener("dragstart", (event) => {
   event.dataTransfer.setData("text/plain", card.dataset.protocolId);
   card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openProtocolDrawer(card.dataset.protocolId));
 });
 document.querySelectorAll("#protocolKanbanBoard [data-protocol-drop-status]").forEach((dropZone) => {
  dropZone.addEventListener("dragover", (event) => {
   event.preventDefault();
   dropZone.classList.add("drop-active");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drop-active"));
  dropZone.addEventListener("drop", (event) => {
   event.preventDefault();
   dropZone.classList.remove("drop-active");
   changeProtocolStatus(event.dataTransfer.getData("text/plain"), dropZone.dataset.protocolDropStatus, { reopenDrawer: false });
  });
 });
}

function protocolRow(protocol) {
 const deadline = protocolDeadlineInfo(protocol);
 const statusInfo = protocolStatusInfo(protocol.status);
 return `<tr class="protocol-row" data-protocol-open="${protocol.id}">
  <td>${projectBadge(statusInfo.label, statusInfo.tone)}</td>
  <td>${projectBadge(deadline.label, deadline.tone)}</td>
  <td>${escapeHtml(utilityCompanyName(protocol.utilityCompanyId))}</td>
  <td>${escapeHtml(personName(protocol.customerId))}</td>
  <td>${protocol.projectId ? escapeHtml(projectName(protocol.projectId)) : "Sem projeto"}</td>
  <td>${escapeHtml(protocol.protocolNumber || "-")}</td>
  <td>${escapeHtml(userName(protocol.responsibleUserId))}</td>
  <td>${escapeHtml(activityTypeName(protocol.activityTypeId))}</td>
  <td>${formatDate((protocol.lastMovementAt || protocol.updatedAt || protocol.createdAt || "").slice(0, 10))}</td>
  <td>${projectBadge(priorityLabel(protocol.priority), priorityTone(protocol.priority))}</td>
 </tr>`;
}

function clearProtocolFilters() {
 if (els.protocolSearch) els.protocolSearch.value = "";
 if (els.protocolFilterCity) els.protocolFilterCity.value = "";
 [
  [els.protocolFilterUtility, "todos"],
  [els.protocolFilterActivityType, "todos"],
  [els.protocolFilterStatus, "todos"],
  [els.protocolFilterResponsible, "todos"],
  [els.protocolFilterProject, "todos"],
  [els.protocolFilterDeadline, "todos"],
  [els.protocolFilterPriority, "todos"],
  [els.protocolFilterPeriod, "todos"],
 ].forEach(([field, value]) => { if (field) field.value = value; });
 renderProtocols();
}

function openProtocolDialog(protocol = null) {
 els.protocolForm.reset();
 hydrateProtocolOptions();
 els.protocolId.value = protocol.id || "";
 els.protocolInternalNumber.value = protocol.internalNumber || nextProtocolInternalNumber();
 els.protocolNumber.value = protocol.protocolNumber || "";
 els.protocolActivityType.value = protocol.activityTypeId || els.protocolActivityType.value;
 els.protocolUtility.value = protocol.utilityCompanyId || els.protocolUtility.value;
 els.protocolCustomer.value = protocol.customerId || "";
 els.protocolCity.value = protocol.city || "";
 els.protocolConsumerUnit.value = protocol.consumerUnit || "";
 els.protocolProject.value = protocol.projectId || "";
 els.protocolStatus.value = protocol.status || "novo";
 els.protocolResponsible.value = protocol.responsibleUserId || "";
 els.protocolOpenedAt.value = protocol.openedAt || todayIso;
 els.protocolDeadline.value = protocol.utilityDeadline || "";
 els.protocolExpectedDate.value = protocol.expectedDate || "";
 els.protocolPriority.value = protocol.priority || "media";
 els.protocolNotes.value = protocol.notes || "";
 els.protocolDialogTitle.textContent = protocol ? "Editar protocolo" : "Novo protocolo";
 els.protocolDialog.showModal();
}

function saveProtocol() {
 const id = els.protocolId.value || crypto.randomUUID();
 const existing = state.protocols.find((item) => item.id === id);
 const now = new Date().toISOString();
 const newStatus = els.protocolStatus.value;
 const data = {
  id,
  internalNumber: existing.internalNumber || els.protocolInternalNumber.value || nextProtocolInternalNumber(),
  protocolNumber: els.protocolNumber.value.trim().slice(0, 15),
  activityTypeId: els.protocolActivityType.value,
  utilityCompanyId: els.protocolUtility.value,
  customerId: els.protocolCustomer.value,
  city: els.protocolCity.value.trim(),
  consumerUnit: els.protocolConsumerUnit.value.trim(),
  projectId: els.protocolProject.value,
  status: newStatus,
  responsibleUserId: els.protocolResponsible.value,
  openedAt: els.protocolOpenedAt.value,
  utilityDeadline: els.protocolDeadline.value,
  expectedDate: els.protocolExpectedDate.value,
  priority: els.protocolPriority.value,
  notes: els.protocolNotes.value.trim(),
  checklist: existing.checklist || [],
  lastMovementAt: now,
  createdAt: existing.createdAt || now,
  updatedAt: now,
 };

 const index = state.protocols.findIndex((item) => item.id === id);
 if (index >= 0) {
  if (existing.status !== newStatus) addProtocolHistory(id, "Mudan?a de status", existing.status, newStatus);
  state.protocols[index] = data;
 } else {
  if (!data.checklist.length && PROTOCOL_CHECKLIST_TEMPLATES[data.activityTypeId]) {
   data.checklist = PROTOCOL_CHECKLIST_TEMPLATES[data.activityTypeId].map((label) => ({ id: crypto.randomUUID(), label, status: "pendente" }));
  }
  state.protocols.push(data);
  addProtocolHistory(id, "Abertura do protocolo", "", newStatus);
 }

 const releasesProject = newStatus === PROTOCOL_RELEASE_STATUS && data.projectId;
 if (releasesProject) {
  releaseProjectFromHomologation(data.projectId);
 }

 persist(releasesProject ? ["protocolo", "projetos"] : "protocolo");
 renderAll();
 els.protocolDialog.close();
 toast("Protocolo salvo.");
}

function addProtocolHistory(protocolId, action, fromStatus, toStatus, notes = "") {
 const user = currentSessionUser();
 state.protocolHistory.push({
  id: crypto.randomUUID(),
  protocolId,
  action,
  fromStatus,
  toStatus,
  user: user ? (user.name || user.username) : "Usu?rio local",
  createdAt: new Date().toISOString(),
  notes,
 });
}

function protocolHistoryHtml(protocolId) {
 const rows = state.protocolHistory
  .filter((item) => item.protocolId === protocolId)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
 return rows.length ?
   rows.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.action)}</span><span>${formatDate(row.createdAt.slice(0, 10))} ${escapeHtml(row.createdAt.slice(11, 16))}</span></strong>
    <span class="muted">${row.fromStatus ? `${escapeHtml(protocolStatusLabel(row.fromStatus))} ? ` : ""}${row.toStatus ? escapeHtml(protocolStatusLabel(row.toStatus)) : ""} ? ${escapeHtml(row.user)}</span>
    ${row.notes ? `<span class="muted">${escapeHtml(row.notes)}</span>` : ""}
   </article>`).join("")
  : emptyMessage("Sem hist?rico registrado.");
}

function protocolChecklistHtml(protocol) {
 if (!protocol.checklist.length) return emptyMessage("Nenhum item de checklist.");
 return protocol.checklist.map((item) => `
  <div class="protocol-checklist-item">
   <span>${escapeHtml(item.label)}</span>
   <select data-checklist-status data-protocol-id="${protocol.id}" data-item-id="${item.id}">
    ${["pendente", "enviado", "aprovado", "rejeitado"].map((status) => `<option value="${status}" ${item.status === status ? "selected" : ""}>${checklistStatusLabel(status)}</option>`).join("")}
   </select>
  </div>`).join("");
}

function openProtocolDrawer(protocolId) {
 const protocol = state.protocols.find((item) => item.id === protocolId);
 const drawer = document.querySelector("#protocolDrawer");
 const content = els.protocolDrawerContent;
 if (!protocol || !drawer || !content) return;
 const deadline = protocolDeadlineInfo(protocol);
 const statusInfo = protocolStatusInfo(protocol.status);
 const project = protocol.projectId ? state.projects.find((item) => item.id === protocol.projectId) : null;

 content.innerHTML = `
  <div class="drawer-header">
   <div>
    <small>${escapeHtml(utilityCompanyName(protocol.utilityCompanyId))} ? ${escapeHtml(protocol.internalNumber)}</small>
    <h3>${escapeHtml(personName(protocol.customerId))}</h3>
   </div>
   ${projectBadge(deadline.label, deadline.tone)}
  </div>
  <div class="drawer-grid">
   ${drawerMetric("Status", statusInfo.label)}
   ${drawerMetric("Prioridade", priorityLabel(protocol.priority))}
   ${drawerMetric("Protocolo", protocol.protocolNumber || "-")}
   ${drawerMetric("UC", protocol.consumerUnit || "-")}
  </div>
  <section class="drawer-section">
   <h4>Alterar status</h4>
   <select id="protocolDrawerStatus" data-protocol-id="${protocol.id}">
    ${PROTOCOL_STATUSES.map((status) => `<option value="${status.id}" ${protocol.status === status.id ? "selected" : ""}>${escapeHtml(status.label)}</option>`).join("")}
   </select>
  </section>
  <section class="drawer-section">
   <h4>Alterar respons?vel</h4>
   <select id="protocolDrawerResponsible" data-protocol-id="${protocol.id}">
    ${protocolResponsibleOptions(protocol.responsibleUserId)}
   </select>
  </section>
  ${drawerSection("Dados do protocolo", [
   ["Tipo de atividade", activityTypeName(protocol.activityTypeId)],
   ["Cidade", protocol.city || "-"],
   ["Respons?vel", userName(protocol.responsibleUserId)],
   ["Abertura", formatDate(protocol.openedAt)],
   ["Prazo da concession?ria", formatDate(protocol.utilityDeadline)],
   ["Previs?o", formatDate(protocol.expectedDate)],
   ["Ãšltima movimentação", formatDate((protocol.lastMovementAt || "").slice(0, 10))],
   ["Projeto vinculado", project ? projectLabel(project) : "Sem projeto vinculado"],
  ])}
  ${protocol.notes ? `<section class="drawer-section"><h4>Observaúes</h4><p>${escapeHtml(protocol.notes)}</p></section>` : ""}
  <section class="drawer-section">
   <h4>Checklist / documentos</h4>
   <div class="protocol-checklist">${protocolChecklistHtml(protocol)}</div>
   <div class="inline-control">
    <input type="text" id="protocolNewChecklistItem" placeholder="Novo item de checklist" maxlength="80" />
    <button class="secondary-btn" type="button" id="addProtocolChecklistItemBtn" data-protocol-id="${protocol.id}">Adicionar</button>
   </div>
  </section>
  <section class="drawer-section">
   <h4>Hist?rico</h4>
   <div class="protocol-history">${protocolHistoryHtml(protocol.id)}</div>
   <div class="inline-control">
    <input type="text" id="protocolNewNote" placeholder="Registrar observação/movimentação" maxlength="200" />
    <button class="secondary-btn" type="button" id="addProtocolNoteBtn" data-protocol-id="${protocol.id}">Registrar</button>
   </div>
  </section>
  <menu class="modal-actions">
   <button class="secondary-btn" type="button" id="editProtocolFromDrawerBtn" data-protocol-id="${protocol.id}">Editar dados</button>
   ${project ? `<button class="secondary-btn" type="button" id="openInstallationFromProtocolBtn" data-protocol-id="${protocol.id}">Programar instalação</button>` : ""}
  </menu>
 `;
 drawer.classList.add("open");
 drawer.setAttribute("aria-hidden", "false");
 bindProtocolDrawerEvents();
}

function closeProtocolDrawer() {
 const drawer = document.querySelector("#protocolDrawer");
 if (!drawer) return;
 drawer.classList.remove("open");
 drawer.setAttribute("aria-hidden", "true");
}

function bindProtocolDrawerEvents() {
 document.querySelector("#protocolDrawerStatus").addEventListener("change", (event) => {
  changeProtocolStatus(event.target.dataset.protocolId, event.target.value);
 });
 document.querySelector("#protocolDrawerResponsible").addEventListener("change", (event) => {
  changeProtocolResponsible(event.target.dataset.protocolId, event.target.value);
 });
 document.querySelectorAll("[data-checklist-status]").forEach((select) => {
  select.addEventListener("change", (event) => {
   setChecklistItemStatus(event.target.dataset.protocolId, event.target.dataset.itemId, event.target.value);
  });
 });
 document.querySelector("#addProtocolChecklistItemBtn").addEventListener("click", (event) => {
  const input = document.querySelector("#protocolNewChecklistItem");
  const label = input.value.trim();
  if (!label) return;
  addChecklistItem(event.target.dataset.protocolId, label);
  input.value = "";
 });
 document.querySelector("#addProtocolNoteBtn").addEventListener("click", (event) => {
  const input = document.querySelector("#protocolNewNote");
  const notes = input.value.trim();
  if (!notes) return;
  const protocolId = event.target.dataset.protocolId;
  addProtocolHistory(protocolId, "Observação registrada", "", "", notes);
  persist("protocolo");
  renderProtocols();
  openProtocolDrawer(protocolId);
 });
 document.querySelector("#editProtocolFromDrawerBtn").addEventListener("click", (event) => {
  openProtocolDialog(state.protocols.find((item) => item.id === event.target.dataset.protocolId));
 });
 document.querySelector("#openInstallationFromProtocolBtn").addEventListener("click", (event) => {
  const protocol = state.protocols.find((item) => item.id === event.target.dataset.protocolId);
  const project = protocol ? state.projects.find((item) => item.id === protocol.projectId) : null;
  if (project) openInstallationForProject(project);
 });
}

function changeProtocolStatus(protocolId, newStatus, { reopenDrawer = true } = {}) {
 const protocol = state.protocols.find((item) => item.id === protocolId);
 if (!protocol || protocol.status === newStatus) return;
 const previousStatus = protocol.status;
 protocol.status = newStatus;
 protocol.lastMovementAt = new Date().toISOString();
 protocol.updatedAt = protocol.lastMovementAt;
 addProtocolHistory(protocolId, "Mudan?a de status", previousStatus, newStatus);
 if (newStatus === PROTOCOL_RELEASE_STATUS && protocol.projectId) {
  releaseProjectFromHomologation(protocol.projectId);
 }
 persist();
 renderProtocols();
 if (reopenDrawer) openProtocolDrawer(protocolId);
 toast("Status do protocolo atualizado.");
}

function protocolResponsibleOptions(selectedId = "") {
 const users = state.users.filter((user) => user.active !== false);
 return `<option value="" ${selectedId ? "" : "selected"}>Sem respons?vel</option>${users.map((user) =>
  `<option value="${user.id}" ${user.id === selectedId ? "selected" : ""}>${escapeHtml(user.name || user.username)}</option>`
 ).join("")}`;
}

function changeProtocolResponsible(protocolId, responsibleUserId) {
 const protocol = state.protocols.find((item) => item.id === protocolId);
 if (!protocol || protocol.responsibleUserId === responsibleUserId) return;
 const previous = userName(protocol.responsibleUserId);
 protocol.responsibleUserId = responsibleUserId;
 protocol.lastMovementAt = new Date().toISOString();
 protocol.updatedAt = protocol.lastMovementAt;
 addProtocolHistory(protocolId, "Respons?vel atualizado", "", "", `${previous} -> ${userName(responsibleUserId)}`);
 persist("protocolo");
 renderProtocols();
 openProtocolDrawer(protocolId);
 toast("Respons?vel do protocolo atualizado.");
}

function setChecklistItemStatus(protocolId, itemId, status) {
 const protocol = state.protocols.find((item) => item.id === protocolId);
 const item = protocol.checklist.find((entry) => entry.id === itemId);
 if (!item) return;
 item.status = status;
 protocol.lastMovementAt = new Date().toISOString();
 protocol.updatedAt = protocol.lastMovementAt;
 addProtocolHistory(protocolId, "Checklist atualizado", "", "", `${item.label}: ${checklistStatusLabel(status)}`);
 persist("protocolo");
 renderProtocols();
 openProtocolDrawer(protocolId);
}

function addChecklistItem(protocolId, label) {
 const protocol = state.protocols.find((item) => item.id === protocolId);
 if (!protocol) return;
 protocol.checklist.push({ id: crypto.randomUUID(), label, status: "pendente" });
 protocol.lastMovementAt = new Date().toISOString();
 protocol.updatedAt = protocol.lastMovementAt;
 persist();
 renderProtocols();
 openProtocolDrawer(protocolId);
}

function releaseProjectFromHomologation(projectId) {
 const project = state.projects.find((item) => item.id === projectId);
 if (!project || project.status === PROJECT_STATUS_RELEASED_FOR_INSTALLATION) return;
 project.status = PROJECT_STATUS_RELEASED_FOR_INSTALLATION;
 upsertCostCenter(project);
}

function protocolProjectSectionHtml(projectId) {
 const linked = state.protocols.filter((item) => item.projectId === projectId);
 if (!linked.length) return "";
 return `<section class="drawer-section"><h4>Protocolos na concession?ria</h4>${linked.map((protocol) => {
  const deadline = protocolDeadlineInfo(protocol);
  const statusInfo = protocolStatusInfo(protocol.status);
  return `<button type="button" class="protocol-link-row" data-open-protocol="${protocol.id}">
   <span>${escapeHtml(utilityCompanyName(protocol.utilityCompanyId))} ? ${escapeHtml(activityTypeName(protocol.activityTypeId))}</span>
   ${projectBadge(statusInfo.label, statusInfo.tone)}
   ${projectBadge(deadline.label, deadline.tone)}
  </button>`;
 }).join("")}</section>`;
}

function createPersonFromProtocolDialog() {
 quickPersonTarget = "protocol";
 els.quickPersonForm.reset();
 els.quickPersonType.value = "cliente";
 els.quickPersonName.value = "";
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function openProtocolSettingsDialog() {
 renderUtilityCompanyList();
 renderActivityTypeList();
 els.protocolSettingsDialog.showModal();
}

function renderUtilityCompanyList() {
 els.utilityCompanyList.innerHTML = state.utilityCompanies.length ?
   state.utilityCompanies.map((item) => `
   <article class="person-item">
    <strong><span>${escapeHtml(item.name)}</span><span>${item.active ? "Ativa" : "Inativa"}</span></strong>
    <div class="row-actions">
     <button type="button" data-toggle-utility="${item.id}">${item.active ? "Inativar" : "Ativar"}</button>
    </div> ?
   </article>`).join("")
  : emptyMessage("Nenhuma concession?ria cadastrada.");
 document.querySelectorAll("[data-toggle-utility]").forEach((button) => {
  button.addEventListener("click", () => toggleUtilityCompanyActive(button.dataset.toggleUtility));
 });
}

function addUtilityCompany() {
 const name = els.utilityCompanyNameInput.value.trim();
 if (!name) return;
 state.utilityCompanies.push({ id: crypto.randomUUID(), name, active: true });
 els.utilityCompanyNameInput.value = "";
 persist();
 renderUtilityCompanyList();
 hydrateProtocolOptions();
 toast("Concession?ria adicionada.");
}

function toggleUtilityCompanyActive(id) {
 const item = state.utilityCompanies.find((entry) => entry.id === id);
 if (!item) return;
 item.active = !item.active;
 persist();
 renderUtilityCompanyList();
 hydrateProtocolOptions();
}

function renderActivityTypeList() {
 els.activityTypeList.innerHTML = state.protocolActivityTypes.length ?
   state.protocolActivityTypes.map((item) => `
   <article class="person-item">
    <strong><span>${escapeHtml(item.name)}</span><span>${item.active ? "Ativo" : "Inativo"}</span></strong>
    <div class="row-actions">
     <button type="button" data-toggle-activity-type="${item.id}">${item.active ? "Inativar" : "Ativar"}</button>
    </div> ?
   </article>`).join("")
  : emptyMessage("Nenhum tipo cadastrado.");
 document.querySelectorAll("[data-toggle-activity-type]").forEach((button) => {
  button.addEventListener("click", () => toggleActivityTypeActive(button.dataset.toggleActivityType));
 });
}

function addActivityType() {
 const name = els.activityTypeNameInput.value.trim();
 if (!name) return;
 state.protocolActivityTypes.push({ id: crypto.randomUUID(), name, active: true });
 els.activityTypeNameInput.value = "";
 persist();
 renderActivityTypeList();
 hydrateProtocolOptions();
 toast("Tipo de atividade adicionado.");
}

function toggleActivityTypeActive(id) {
 const item = state.protocolActivityTypes.find((entry) => entry.id === id);
 if (!item) return;
 item.active = !item.active;
 persist();
 renderActivityTypeList();
 hydrateProtocolOptions();
}

// ===================== fim Central de Protocolos =====================

function legacyOpenInstallationForProject(project) {
 setView("instalacoes");
 resetInstallationForm();
 els.installationProject.value = project.id;
 els.installationCustomer.value = project.customerId;
 els.installationScheduledDate.value = project.endDate || "";
 toast("Revise os dados e salve a instalação.");
}

function legacyResetInstallationForm() {
 els.installationForm.reset();
 els.installationId.value = "";
 hydrateProjectOptions();
}

function legacyInstallationStatusLabel(status) {
 return {
  programada: "Programada",
  em_andamento: "Em andamento",
  concluida: "Concluída",
  pendente: "Pendente",
  cancelada: "Cancelada",
 }[status] || status;
}

function legacyRenderInstallations() {
 hydrateProjectOptions();
 const search = (els.installationSearch.value || "").toLowerCase().trim();
 const rows = state.installations
  .filter((item) => `${projectName(item.projectId)} ${personName(item.customerId)} ${item.team} ${item.status}`.toLowerCase().includes(search))
  .sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));

 els.installationList.innerHTML = rows.length ?
   rows.map((item) => `
   <article class="person-item">
    <strong><span>${escapeHtml(projectName(item.projectId))}</span><span>${installationStatusLabel(item.status)}</span></strong>
    <span class="muted">${escapeHtml(personName(item.customerId))} ? ${formatDate(item.scheduledDate)} ? ${escapeHtml(item.team || "Sem equipe")}</span>
    <span class="muted">${escapeHtml(item.materials || "Materiais não informados")}</span>
    <div class="row-actions">
     <button type="button" data-installation-action="edit" data-id="${item.id}">Editar</button>
     <button type="button" data-installation-action="complete" data-id="${item.id}">Concluir</button>
    </div> ?
   </article>`).join("")
  : emptyMessage("Nenhuma instalação cadastrada.");

 document.querySelectorAll("[data-installation-action]").forEach((button) => {
  button.addEventListener("click", () => handleInstallationAction(button.dataset.installationAction, button.dataset.id));
 });
}

function legacySaveInstallation(event) {
 event.preventDefault();
 const id = els.installationId.value || crypto.randomUUID();
 const existing = state.installations.find((item) => item.id === id);
 const project = state.projects.find((item) => item.id === els.installationProject.value);
 const data = {
  id,
  projectId: els.installationProject.value,
  customerId: els.installationCustomer.value || project.customerId || "",
  status: els.installationStatus.value,
  scheduledDate: els.installationScheduledDate.value,
  team: els.installationTeam.value.trim(),
  materials: els.installationMaterials.value.trim(),
  notes: els.installationNotes.value.trim(),
  conclusion: els.installationConclusion.value.trim(),
  opportunityId: existing.opportunityId || "",
  contractId: existing.contractId || "",
  createdAt: existing.createdAt || new Date().toISOString(),
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

function legacyHandleInstallationAction(action, id) {
 const installation = state.installations.find((item) => item.id === id);
 if (!installation) return;
 if (action === "edit") {
  setInstallationFormVisible(true);
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
  persist("projetos");
  renderAll();
  toast("Instalação concluída.");
 }
}

function openInstallationForProject(project) {
 setView("instalacoes");
 resetInstallationForm();
 setInstallationFormVisible(true);
 els.installationProject.value = project.id;
 els.installationCustomer.value = project.customerId;
 els.installationServiceType.value = "instalacao_projeto";
 els.installationClosedDate.value = todayIso;
 els.installationPostSaleDueDate.value = addBusinessDaysIso(todayIso, 2);
 els.installationPostSaleContactedAt.value = "";
 els.installationDeadlineDate.value = addBusinessDaysIso(todayIso, 15);
 els.installationScheduledDate.value = project.endDate || "";
 updateInstallationFormCalculations();
 toast("Revise os dados e salve o serviço.");
}

function setInstallationFormVisible(visible) {
 if (!els.installationForm) return;
 els.installationForm.classList.toggle("hidden", !visible);
 if (els.toggleInstallationFormBtn) {
  els.toggleInstallationFormBtn.textContent = visible ? "Ocultar cadastro" : "Novo serviço / instalação";
 }
}

function scrollToInstallationForm() {
 window.setTimeout(() => {
  els.installationForm.scrollIntoView({ behavior: "smooth", block: "start" });
 }, 50);
}

function resetInstallationForm() {
 els.installationForm.reset();
 els.installationId.value = "";
 els.deleteInstallationBtn.classList.add("hidden");
 els.installationStatus.value = "sem_programacao";
 els.installationServiceType.value = "instalacao_projeto";
 els.installationClosedDate.value = todayIso;
 els.installationPostSaleDueDate.value = addBusinessDaysIso(todayIso, 2);
 els.installationPostSaleContactedAt.value = "";
 els.installationDeadlineDate.value = addBusinessDaysIso(todayIso, 15);
 if (els.installationOutsourcingCost) els.installationOutsourcingCost.value = "";
 renderInstallationLaborRows();
 renderInstallationWorkerList();
 setTechnicalReportForm({}, "instalacao_projeto");
 hydrateProjectOptions();
 updateInstallationFormCalculations();
}

function installationTypeLabel(type) {
 return {
  instalacao_projeto: "Instala\u00e7\u00e3o de projeto",
  ampliacao: "Amplia\u00e7\u00e3o",
  manutencao_preventiva: "Manuten\u00e7\u00e3o preventiva",
  manutencao_corretiva: "Manuten\u00e7\u00e3o corretiva",
  retrabalho: "Retrabalho",
  pos_venda: "P\u00f3s venda",
 }[type] || "Instala\u00e7\u00e3o de projeto";
}

function installationRequiresProject(serviceType) {
 return ["instalacao_projeto", "ampliacao"].includes(serviceType);
}

function installationStatusLabel(status) {
 return {
  sem_programacao: "Sem programa\u00e7\u00e3o",
  aguardando_projeto: "Aguardando projeto",
  aguardando_material: "Aguardando material",
  aguardando_cliente: "Aguardando cliente",
  aguardando_instalacao: "Aguardando instala\u00e7\u00e3o",
  aguardando_entrega_tecnica: "Aguardando entrega t\u00e9cnica",
  programada: "Programada",
  em_andamento: "Em andamento",
  concluida: "Conclu\u00edda",
  pendente: "Pendente",
  cancelada: "Cancelada",
 }[status] || "Programada";
}

function technicalPhotoTemplates(serviceType) {
 const common = [
  { key: "area_antes", label: "Local antes do serviço" },
  { key: "area_depois", label: "Local ap?s o serviço" },
  { key: "equipamentos", label: "Equipamentos / inversores" },
  { key: "teste_funcionamento", label: "Teste de funcionamento / geração" },
  { key: "seriais", label: "Seriais dos equipamentos" },
 ];
 if (serviceType === "instalacao_projeto" || serviceType === "ampliacao") {
  return [
   { key: "telhado_antes", label: "Telhado antes da instalação" },
   { key: "suportes", label: "Suportes das placas instalados" },
   { key: "placas_instaladas", label: "Placas instaladas" },
   { key: "inversores", label: "Inversores instalados" },
   { key: "geracao", label: "Geração do sistema" },
   { key: "seriais", label: "Seriais dos inversores" },
  ];
 }
 return common;
}

function technicalReportFromForm() {
 return {
  warrantyStartDate: els.technicalWarrantyStart.value,
  technician: els.technicalTechnician.value.trim(),
  whatsapp: els.technicalWhatsapp.value.trim(),
  email: els.technicalEmail.value.trim(),
  summary: els.technicalSummary.value.trim(),
  photos: technicalReportDraftPhotos,
  generatedAt: "",
 };
}

function setTechnicalReportForm(report = {}, serviceType = "instalacao_projeto") {
 technicalReportDraftPhotos = Array.isArray(report.photos) ?
   report.photos.map((photo) => ({ id: photo.id || crypto.randomUUID(), ...photo }))
  : [];
 els.technicalWarrantyStart.value = report.warrantyStartDate || "";
 els.technicalTechnician.value = report.technician || currentSessionUser().name || "";
 els.technicalWhatsapp.value = report.whatsapp || "";
 els.technicalEmail.value = report.email || "";
 els.technicalSummary.value = report.summary || "";
 renderTechnicalPhotoGrid(serviceType);
}

function photosForTechnicalSlot(slotKey) {
 return technicalReportDraftPhotos.filter((item) => item.key === slotKey);
}

function renderTechnicalPhotoGrid(serviceType = "instalacao_projeto") {
 if (!els.technicalPhotoGrid) return;
 const templates = technicalPhotoTemplates(serviceType);
 els.technicalPhotoGrid.innerHTML = templates.map((template) => {
  const photos = photosForTechnicalSlot(template.key);
  return `
   <article class="technical-photo-slot">
    <div class="technical-photo-slot-head">
     <strong>${escapeHtml(template.label)}</strong>
     <span>${photos.length ? `${photos.length} foto(s)` : "Sem foto"}</span>
    </div>
    <div class="technical-photo-preview ${photos.length ? "has-photos" : ""}">
     ${photos.length ? photos.map((photo, index) => `
      <figure class="technical-photo-thumb">
       <img src="${photo.dataUrl}" alt="${escapeHtml(photo.label || template.label)} ${index + 1}" />
       <button type="button" class="icon-btn danger-mini" data-remove-technical-photo="${photo.id}" title="Remover foto">x</button>
      </figure>
     `).join("") : `<span>Sem foto</span>`}
    </div>
    <label class="secondary-btn file-btn">
     Anexar foto deste item
     <input type="file" accept="image/*" capture="environment" multiple data-technical-photo="${template.key}" data-technical-label="${escapeHtml(template.label)}" />
    </label>
   </article>
  `;
 }).join("");
}

async function handleTechnicalPhotoUpload(event) {
 const input = event.target;
 if (!input.matches("[data-technical-photo]") || !input.files?.[0]) return;
 const files = Array.from(input.files);
 const entries = await Promise.all(files.map(async (file) => ({
  id: crypto.randomUUID(),
  key: input.dataset.technicalPhoto,
  label: input.dataset.technicalLabel,
  fileName: file.name,
  dataUrl: await compressImageFile(file, 1280, 0.72),
  capturedAt: new Date().toISOString(),
 })));
 technicalReportDraftPhotos.push(...entries);
 input.value = "";
 renderTechnicalPhotoGrid(els.installationServiceType.value);
}

function handleTechnicalPhotoRemove(event) {
 const button = event.target.closest("[data-remove-technical-photo]");
 if (!button) return;
 technicalReportDraftPhotos = technicalReportDraftPhotos.filter((photo) => photo.id !== button.dataset.removeTechnicalPhoto);
 renderTechnicalPhotoGrid(els.installationServiceType.value);
}

function compressImageFile(file, maxSize = 1280, quality = 0.72) {
 return new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
   const image = new Image();
   image.onload = () => {
    const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    resolve(canvas.toDataURL("image/jpeg", quality));
   };
   image.onerror = reject;
   image.src = reader.result;
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
 });
}

function samplePhotoDataUrl(label, index) {
 const bg = ["#1f4f46", "#876514", "#324b67", "#703d3d", "#4b5f32", "#58466b"][index % 6];
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#fff">Lumeris Engenharia</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#fff">${escapeHtml(label)}</text></svg>`;
 return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function fillSampleTechnicalReport() {
 const templates = technicalPhotoTemplates(els.installationServiceType.value);
 technicalReportDraftPhotos = templates.map((template, index) => ({
  id: crypto.randomUUID(),
  key: template.key,
  label: template.label,
  dataUrl: samplePhotoDataUrl(template.label, index),
  capturedAt: new Date().toISOString(),
 }));
 if (!els.technicalWarrantyStart.value) els.technicalWarrantyStart.value = els.installationCompletedDate.value || todayIso;
 if (!els.technicalSummary.value) els.technicalSummary.value = "Serviço executado e validado conforme checklist técnico da Lumeris Engenharia.";
 renderTechnicalPhotoGrid(els.installationServiceType.value);
 toast("Fotos teste inseridas no relatério técnico.");
}

function technicalReportHtml(installation, report) {
 const project = state.projects.find((item) => item.id === installation.projectId);
 const client = state.people.find((item) => item.id === installation.customerId);
 const efficiency = installationEfficiency(installation);
 const photos = report.photos || [];
 return `<!doctype html>
  <html lang="pt-BR">
  <head>
   <meta charset="utf-8" />
   <title>Entrega técnica - ${escapeHtml(projectName(installation.projectId))}</title>
   <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #17231f; margin: 0; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 2px solid #146c5f; padding-bottom: 14px; margin-bottom: 18px; }
    header img { width: 170px; background: #050505; padding: 8px; border-radius: 4px; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 18px 0 8px; font-size: 17px; color: #146c5f; }
    .muted { color: #61706a; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
    .box { border: 1px solid #d7dfda; border-radius: 6px; padding: 10px; }
    .box strong { display: block; font-size: 12px; color: #61706a; margin-bottom: 4px; }
    .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .photo { break-inside: avoid; border: 1px solid #d7dfda; border-radius: 6px; padding: 8px; }
    .photo img { width: 100%; height: 190px; object-fit: cover; border-radius: 4px; background: #eef3f0; }
    .photo strong { display: block; margin-bottom: 6px; }
    footer { margin-top: 24px; border-top: 1px solid #d7dfda; padding-top: 12px; font-size: 12px; color: #61706a; }
   </style>
  </head>
  <body>
   <header>
    <img src="assets/logo-lumeris.png" alt="Lumeris Engenharia" />
    <div>
     <h1>Relatério de Entrega Técnica</h1>
     <div class="muted">Lumeris Engenharia ? ${formatDate(todayIso)}</div>
    </div>
   </header>

   <section class="grid">
    <div class="box"><strong>Cliente</strong>${escapeHtml(client.name || personName(installation.customerId))}</div>
    <div class="box"><strong>Projeto</strong>${escapeHtml(project.name || projectName(installation.projectId))}</div>
    <div class="box"><strong>Tipo de serviço</strong>${escapeHtml(installationTypeLabel(installation.serviceType))}</div>
    <div class="box"><strong>Status</strong>${escapeHtml(installationStatusLabel(installation.status))}</div>
    <div class="box"><strong>Conclusão</strong>${formatDate(installation.completedDate || todayIso)}</div>
    <div class="box"><strong>In?cio da garantia</strong>${formatDate(report.warrantyStartDate || installation.completedDate || todayIso)}</div>
    <div class="box"><strong>Técnico respons?vel</strong>${escapeHtml(report.technician || installation.team || "-")}</div>
    <div class="box"><strong>Contato do cliente</strong>${escapeHtml(report.whatsapp || client.contact || "-")} ${report.email ? "? " + escapeHtml(report.email) : ""}</div>
   </section>

   <h2>Resumo técnico</h2>
   <div class="box">${escapeHtml(report.summary || installation.conclusion || "Serviço finalizado conforme padr?o técnico da Lumeris Engenharia.")}</div>

   <h2>Eficiência da execução</h2>
   <section class="grid">
    <div class="box"><strong>Placas instaladas</strong>${installation.panels || 0}</div>
    <div class="box"><strong>Custo equipe</strong>${money(efficiency.own)}</div>
    <div class="box"><strong>Refer?ncia R$ 120/placa</strong>${money(Number(installation.panels || 0) * 120)}</div>
    <div class="box"><strong>Terceiro contratado / pago</strong>${installation.outsourcingCost ? money(installation.outsourcingCost) : "Não informado"}</div>
    <div class="box"><strong>Resultado comparativo</strong>${money(efficiency.saving)}</div>
   </section>

   <h2>Registro fotogr?fico</h2>
   <section class="photos">
    ${photos.map((photo) => `
     <article class="photo">
      <strong>${escapeHtml(photo.label)}</strong>
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.label)}" />
     </article>
    `).join("") || `<div class="box">Nenhuma foto anexada.</div>`}
   </section>

   <footer>
    Documento gerado pelo ERP Lumeris. A garantia passa a contar a partir da data de finalização registrada neste relatério.
   </footer>
   <script>window.addEventListener("load", () => setTimeout(() => window.print(), 400));</script>
  </body>
  </html>`;
}

function currentInstallationFromForm() {
 const existing = state.installations.find((item) => item.id === els.installationId.value);
 const project = state.projects.find((item) => item.id === els.installationProject.value);
 return {
  ...(existing || {}),
  id: els.installationId.value || "preview",
  projectId: els.installationProject.value,
  customerId: els.installationCustomer.value || project.customerId || "",
  serviceType: els.installationServiceType.value,
  status: els.installationStatus.value,
  closedDate: els.installationClosedDate.value,
  postSaleDueDate: els.installationPostSaleDueDate.value || addBusinessDaysIso(els.installationClosedDate.value || todayIso, 2),
  postSaleContactedAt: els.installationPostSaleContactedAt.value,
  deadlineDate: els.installationDeadlineDate.value,
  scheduledDate: els.installationScheduledDate.value,
  completedDate: els.installationCompletedDate.value || todayIso,
  panels: Number(els.installationPanels.value || 0),
  outsourcingCost: Number(els.installationOutsourcingCost.value || 0),
  team: els.installationTeam.value.trim(),
  labor: installationLaborEntriesFromForm(),
  technicalReport: technicalReportFromForm(),
  materials: els.installationMaterials.value.trim(),
  notes: els.installationNotes.value.trim(),
  conclusion: els.installationConclusion.value.trim(),
 };
}

function generateTechnicalDeliveryPdf(installation = null) {
 const source = installation || currentInstallationFromForm();
 if (!source.projectId && !source.customerId) {
  toast("Selecione o projeto antes de gerar a entrega técnica.");
  return;
 }
 const report = installation.technicalReport || technicalReportFromForm();
 const win = window.open("", "_blank");
 if (!win) {
  toast("Permita pop-ups para gerar o PDF da entrega técnica.");
  return;
 }
 win.document.open();
 win.document.write(technicalReportHtml(source, report));
 win.document.close();
}

function isBusinessDay(date) {
 const day = date.getDay();
 return day !== 0 && day !== 6;
}

function addBusinessDaysIso(startIso, businessDays) {
 if (!startIso) return "";
 let current = parseDate(startIso);
 let added = 0;
 while (added < businessDays) {
  current = addDays(current, 1);
  if (isBusinessDay(current)) added += 1;
 }
 return toIso(current);
}

function normalizeInstallationStatus(status) {
 return status === "pendente" ? "sem_programacao" : status || "sem_programacao";
}

function isInstallationWaitingScheduling(item) {
 return normalizeInstallationStatus(item.status) === "sem_programacao";
}

function isInstallationInProgress(item) {
 const status = normalizeInstallationStatus(item.status);
 return status === "em_andamento" || status.startsWith("aguardando_");
}

function installationDeadline(item) {
 return item.deadlineDate || addBusinessDaysIso(item.closedDate || (item.createdAt || "").slice(0, 10) || todayIso, 15);
}

function isInstallationLate(item) {
 if (["concluida", "cancelada"].includes(item.status)) return false;
 const deadline = installationDeadline(item);
 return Boolean(deadline && deadline < todayIso);
}

function installationPostSaleDueDate(item) {
 return item.postSaleDueDate || addBusinessDaysIso(item.closedDate || (item.createdAt || "").slice(0, 10) || todayIso, 2);
}

function isPostSaleContactPending(item) {
 if (["concluida", "cancelada"].includes(normalizeInstallationStatus(item.status))) return false;
 return !item.postSaleContactedAt;
}

function isPostSaleContactLate(item) {
 return isPostSaleContactPending(item) && installationPostSaleDueDate(item) < todayIso;
}

function startOfWeekIso(date = today) {
 const copy = new Date(date);
 const day = copy.getDay() || 7;
 copy.setDate(copy.getDate() - day + 1);
 return toIso(copy);
}

function endOfWeekIso(date = today) {
 return toIso(addDays(parseDate(startOfWeekIso(date)), 6));
}

function installationMonthRef(item) {
 return item.completedDate || item.scheduledDate || item.deadlineDate || item.closedDate || (item.createdAt || "").slice(0, 10);
}

function installationLaborEntriesFromForm() {
 return Array.from(document.querySelectorAll("[data-installation-labor-row]"))
  .map(installationLaborEntryFromRow)
  .filter((entry) => entry.name || entry.role || entry.days || entry.dailyRate || entry.cost || entry.notes);
}

function installationLaborEntryFromRow(row) {
 const dailyRate = Number(row.querySelector("[data-labor-daily-rate]").value || 0);
 const days = Number(row.querySelector("[data-labor-days]").value || 0);
 const legacyCost = Number(row.dataset.legacyCost || 0);
 const cost = dailyRate && days ? roundCurrency(dailyRate * days) : legacyCost;
 return {
  workerId: row.querySelector("[data-labor-worker]").value || "",
  name: row.querySelector("[data-labor-name]").value.trim() || "",
  role: row.querySelector("[data-labor-role]").value.trim() || "",
  dailyRate,
  days,
  hours: days ? days * 8 : Number(row.dataset.legacyHours || 0),
  cost,
  notes: row.querySelector("[data-labor-notes]").value.trim() || "",
 };
}

function installationWorkerOptions(selectedId = "") {
 const options = state.installationWorkers
  .filter((worker) => worker.active !== false)
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((worker) => `<option value="${worker.id}" ${worker.id === selectedId ? "selected" : ""}>${escapeHtml(worker.name)} · ${escapeHtml(worker.role)} · ${money(worker.dailyRate)}</option>`);
 return `<option value="">Selecionar funcionário interno</option>${options.join("")}`;
}

function renderInstallationWorkerList() {
 if (!els.installationWorkerList) return;
 const workers = state.installationWorkers.filter((worker) => worker.active !== false);
 els.installationWorkerList.innerHTML = workers.length ?
   workers
   .sort((a, b) => a.name.localeCompare(b.name))
   .map((worker) => `
    <span class="installation-worker-chip">
     <strong>${escapeHtml(worker.name)}</strong>
     ${escapeHtml(worker.role)} · ${money(worker.dailyRate)}
     <button type="button" data-worker-action="remove" data-id="${worker.id}" title="Remover da lista">x</button>
    </span> ?
   `).join("")
  : `<small class="muted">Cadastre os funcionários internos para puxar a diária automaticamente.</small>`;
 els.installationWorkerList.querySelectorAll("[data-worker-action='remove']").forEach((button) => {
  button.addEventListener("click", () => removeInstallationWorker(button.dataset.id));
 });
}

function addInstallationWorker() {
 const name = els.installationWorkerName.value.trim();
 const role = els.installationWorkerRole.value || "Técnico";
 const dailyRate = Number(els.installationWorkerDailyRate.value || 0);
 if (!name || !dailyRate) {
  toast("Informe nome e valor da diária do funcionário.");
  return;
 }
 const existing = state.installationWorkers.find((worker) => normalizeText(worker.name) === normalizeText(name));
 const data = {
  id: existing.id || crypto.randomUUID(),
  name,
  role,
  dailyRate,
  active: true,
  createdAt: existing.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
 };
 if (existing) Object.assign(existing, data);
 else state.installationWorkers.push(data);
 els.installationWorkerName.value = "";
 els.installationWorkerDailyRate.value = "";
 persist("projetos");
 renderInstallationWorkerList();
 renderInstallationLaborRows(installationLaborEntriesFromForm());
 updateInstallationFormCalculations();
 toast("Funcionário cadastrado.");
}

function removeInstallationWorker(id) {
 const worker = state.installationWorkers.find((item) => item.id === id);
 if (!worker) return;
 worker.active = false;
 worker.updatedAt = new Date().toISOString();
 persist("projetos");
 renderInstallationWorkerList();
 renderInstallationLaborRows(installationLaborEntriesFromForm());
}

function handleInstallationLaborWorkerSelect(event) {
 const select = event.target.closest("[data-labor-worker]");
 if (!select) return;
 const row = select.closest("[data-installation-labor-row]");
 if (!row) return;
 if (!select.value) {
  row.querySelector("[data-labor-name]").value = "";
  row.querySelector("[data-labor-role]").value = "";
  row.querySelector("[data-labor-daily-rate]").value = "";
  row.querySelector("[data-labor-days]").value = "";
  row.querySelector("[data-labor-total]").value = "";
  row.dataset.legacyCost = "0";
  row.dataset.legacyHours = "0";
  updateInstallationFormCalculations();
  return;
 }
 const worker = state.installationWorkers.find((item) => item.id === select.value);
 if (!worker) return;
 row.querySelector("[data-labor-name]").value = worker.name;
 row.querySelector("[data-labor-role]").value = worker.role;
 row.querySelector("[data-labor-daily-rate]").value = worker.dailyRate || "";
 updateInstallationFormCalculations();
}

function installationOwnLaborCost(item) {
 return (item.labor || []).reduce((total, entry) => total + Number(entry.cost || 0), 0);
}

function installationOutsourceCost(item) {
 return Number(item.outsourcingCost || 0) || Number(item.panels || 0) * 120;
}

function installationEfficiency(item) {
 const own = installationOwnLaborCost(item);
 const outsourced = installationOutsourceCost(item);
 const saving = outsourced - own;
 const percent = outsourced > 0 ? (saving / outsourced) * 100 : 0;
 return { own, outsourced, saving, percent };
}

function renderInstallationLaborRows(entries = []) {
 if (!els.installationLaborRows) return;
 const rows = Array.from({ length: 5 }, (_, index) => entries[index] || {});
 els.installationLaborRows.innerHTML = rows.map((entry, index) => {
  const currentCost = (entry.dailyRate && entry.days) ? Number(entry.dailyRate) * Number(entry.days) : Number(entry.cost || 0);
  return `
   <div class="installation-labor-row" data-installation-labor-row data-legacy-cost="${Number(entry.cost || 0)}" data-legacy-hours="${Number(entry.hours || 0)}">
    <span>${index + 1}</span>
    <select data-labor-worker>${installationWorkerOptions(entry.workerId || "")}</select>
    <input data-labor-name maxlength="80" placeholder="Funcionário interno" value="${escapeHtml(entry.name || "")}" />
    <input data-labor-role maxlength="80" placeholder="Função" value="${escapeHtml(entry.role || "")}" />
    <input data-labor-daily-rate type="number" min="0" step="0.01" placeholder="Diária R$" value="${entry.dailyRate || ""}" />
    <input data-labor-days type="number" min="0" step="0.5" placeholder="Dias 0,5" value="${entry.days || ""}" />
    <input data-labor-total type="text" readonly placeholder="Total" value="${currentCost ? money(currentCost) : ""}" />
    <input data-labor-notes maxlength="120" placeholder="Observação" value="${escapeHtml(entry.notes || "")}" />
   </div>
  `;
 }).join("");
}

function updateInstallationLaborTotals() {
 document.querySelectorAll("[data-installation-labor-row]").forEach((row) => {
  const entry = installationLaborEntryFromRow(row);
  const total = row.querySelector("[data-labor-total]");
  if (total) total.value = entry.cost ? money(entry.cost) : "";
  if (entry.dailyRate || entry.days) {
   row.dataset.legacyCost = "0";
   row.dataset.legacyHours = "0";
  }
 });
}
function updateInstallationFormCalculations() {
 if (els.installationClosedDate.value && !els.installationPostSaleDueDate.value) {
  els.installationPostSaleDueDate.value = addBusinessDaysIso(els.installationClosedDate.value, 2);
 }
 if (els.installationClosedDate.value && !els.installationDeadlineDate.value) {
  els.installationDeadlineDate.value = addBusinessDaysIso(els.installationClosedDate.value, 15);
 }
 const panels = Number(els.installationPanels.value || 0);
 const outsourcingCost = Number(els.installationOutsourcingCost.value || 0);
 updateInstallationLaborTotals();
 const labor = installationLaborEntriesFromForm();
 const own = sum(labor.map((entry) => entry.cost));
 const estimatedOutsourced = panels * 120;
 const outsourced = outsourcingCost || estimatedOutsourced;
 const saving = outsourced - own;
 const percent = outsourced > 0 ? (saving / outsourced) * 100 : 0;
 if (!els.installationEfficiencyPreview) return;
 els.installationEfficiencyPreview.innerHTML = `
  <span>Refer?ncia R$ 120/placa: <strong>${money(estimatedOutsourced)}</strong></span>
  <span>Terceiro contratado/pago: <strong>${outsourcingCost ? money(outsourcingCost) : "Não informado"}</strong></span>
  <span>Custo da equipe: <strong>${money(own)}</strong></span>
  <span class="${saving >= 0 ? "ok-text" : "danger-text"}">${saving >= 0 ? "Economia" : "Acima da terceirização"}: <strong>${money(Math.abs(saving))}</strong>${outsourced > 0 ? ` (${percent.toFixed(1)}%)` : ""}</span>
 `;
}

function clearInstallationFilters() {
 els.installationDateStart.value = "";
 els.installationDateEnd.value = "";
 els.installationTypeFilter.value = "todos";
 els.installationStatusFilter.value = "todos";
 els.installationSearch.value = "";
 renderInstallations();
}

function installationMatchesFilters(item) {
 const search = (els.installationSearch.value || "").toLowerCase().trim();
 const start = els.installationDateStart.value;
 const end = els.installationDateEnd.value;
 const type = els.installationTypeFilter.value;
 const status = els.installationStatusFilter.value;
 const refDate = installationMonthRef(item);
 const haystack = [
  projectName(item.projectId),
  personName(item.customerId),
  item.team,
  item.status,
  installationTypeLabel(item.serviceType),
  item.materials,
  item.notes,
 ].join(" ").toLowerCase();
 if (search && !haystack.includes(search)) return false;
 if (start && (!refDate || refDate < start)) return false;
 if (end && (!refDate || refDate > end)) return false;
 if (type !== "todos" && item.serviceType !== type) return false;
 if (status === "atrasada") return isInstallationLate(item);
 if (status !== "todos" && normalizeInstallationStatus(item.status) !== status) return false;
 return true;
}

function renderInstallationKpis() {
 if (!els.installationKpis) return;
 const monthStart = todayIso.slice(0, 8) + "01";
 const monthEnd = toIso(endOfMonth(today));
 const completedMonth = state.installations.filter((item) => {
  const completed = item.completedDate || (item.status === "concluida" ? (item.updatedAt || "").slice(0, 10) : "");
  return completed && completed >= monthStart && completed <= monthEnd;
 });
 const late = state.installations.filter(isInstallationLate);
 const inProgress = state.installations.filter(isInstallationInProgress);
 const unscheduled = state.installations.filter(isInstallationWaitingScheduling);
 const weekStart = startOfWeekIso();
 const weekEnd = endOfWeekIso();
 const postSalePending = state.installations.filter(isPostSaleContactPending);
 const postSaleLate = state.installations.filter(isPostSaleContactLate);
 const enteredWeek = state.installations.filter((item) => {
  const ref = item.closedDate || (item.createdAt || "").slice(0, 10);
  return ref && ref >= weekStart && ref <= weekEnd;
 });
 const completedWeek = state.installations.filter((item) => {
  const completed = item.completedDate || (item.status === "concluida" ? (item.updatedAt || "").slice(0, 10) : "");
  return completed && completed >= weekStart && completed <= weekEnd;
 });
 const efficiencyRows = state.installations.filter((item) => item.status === "concluida" || Number(item.panels || 0) || (item.labor || []).length);
 const ownCost = sum(efficiencyRows.map(installationOwnLaborCost));
 const outsourceCost = sum(efficiencyRows.map(installationOutsourceCost));
 const saving = outsourceCost - ownCost;
 els.installationKpis.innerHTML = [
  { label: "P\u00f3s-venda pendente", value: postSalePending.length, hint: `${postSaleLate.length} contato(s) fora do prazo de 2 dias \u00fateis`, tone: postSaleLate.length ? "danger" : postSalePending.length ? "warn" : "ok" },
  { label: "Entraram na semana", value: enteredWeek.length, hint: `${formatDate(weekStart)} at\u00e9 ${formatDate(weekEnd)}`, tone: "neutral" },
  { label: "Realizados na semana", value: completedWeek.length, hint: `${formatDate(weekStart)} at\u00e9 ${formatDate(weekEnd)}`, tone: "ok" },
  { label: "Realizados no mês", value: completedMonth.length, hint: `${formatDate(monthStart)} até ${formatDate(monthEnd)}`, tone: "neutral" },
  { label: "Em atraso", value: late.length, hint: "Prazo de 15 dias úteis vencido", tone: late.length ? "danger" : "ok" },
  { label: "Em andamento", value: inProgress.length, hint: "Execução aberta", tone: "warn" },
  { label: "Falta programação", value: unscheduled.length, hint: "Aguardando projeto, material, cliente ou instalação", tone: unscheduled.length ? "warn" : "ok" },
  { label: "Eficiência da equipe", value: money(saving), hint: `Terceiro ${money(outsourceCost)} - Equipe ${money(ownCost)}`, tone: saving >= 0 ? "ok" : "danger" },
 ].map((card) => `
  <article class="installation-kpi ${card.tone}">
   <span>${card.label}</span>
   <strong>${card.value}</strong>
   <small>${card.hint}</small>
  </article>
 `).join("");
}

function renderInstallations() {
 hydrateProjectOptions();
 renderInstallationWorkerList();
 const rows = state.installations
  .map((item) => ({ ...item, status: normalizeInstallationStatus(item.status), serviceType: item.serviceType || "instalacao_projeto" }))
  .filter(installationMatchesFilters)
  .sort((a, b) => {
   const lateDiff = Number(isInstallationLate(b)) - Number(isInstallationLate(a));
   if (lateDiff) return lateDiff;
   return (installationDeadline(a) || "9999-12-31").localeCompare(installationDeadline(b) || "9999-12-31");
  });

 renderInstallationKpis();
 els.installationListSummary.textContent = `${rows.length} serviço(s) exibido(s)`;
 els.installationList.innerHTML = rows.length ?
   rows.map((item) => {
   const deadline = installationDeadline(item);
   const efficiency = installationEfficiency(item);
   const late = isInstallationLate(item);
   const postSaleDue = installationPostSaleDueDate(item);
   const postSaleText = item.postSaleContactedAt ? `P\u00f3s-venda em ${formatDate(item.postSaleContactedAt)}` : `Contato at\u00e9 ${formatDate(postSaleDue)}`;
   const summary = item.projectId ? projectSummary(state.projects.find((project) => project.id === item.projectId) || { id: item.projectId }) : null;
   const projectCode = projectDisplayCode(item.projectId);
   return `
    <tr class="${late ? "danger-row" : ""}">
     <td><strong>${formatDate(deadline)}</strong>${late ? `<small class="danger-text">Atrasado</small>` : `<small>${daysBetween(deadline, todayIso)} dia(s)</small>`}</td>
     <td>${formatDate(item.scheduledDate)}<small>${item.completedDate ? `Concluído em ${formatDate(item.completedDate)}` : "Agenda"}</small></td>
     <td><strong>${escapeHtml(projectCode || "-")}</strong><small>${projectCode ? "" : escapeHtml(installationTypeLabel(item.serviceType))}</small></td>
     <td><strong>${escapeHtml(personName(item.customerId))}</strong><small>${escapeHtml(projectName(item.projectId))}</small></td>
     <td><span class="status ${item.status === "concluida" ? "baixado" : late || isPostSaleContactLate(item) ? "vencido" : "aberto"}">${escapeHtml(installationStatusLabel(item.status))}</span><small>${escapeHtml(postSaleText)}</small></td>
     <td>${escapeHtml(item.team || "Sem equipe")}<small>${(item.labor || []).length} pessoa(s) com custo</small></td>
     <td><strong class="${efficiency.saving >= 0 ? "ok-text" : "danger-text"}">${money(efficiency.saving)}</strong><small>${item.panels || 0} placa(s) ? equipe ${money(efficiency.own)}</small></td>
     <td>${summary ? `<strong>${money(summary.grossResult)}</strong><small>Receita ${money(summary.contracted)} ? custos ${money(summary.costs)}</small>` : "<strong>-</strong><small>Sem projeto</small>"}</td>
     <td class="row-actions">
      <button type="button" data-installation-action="edit" data-id="${item.id}">Editar</button>
      <button type="button" data-installation-action="complete" data-id="${item.id}">Concluir</button>
      <button type="button" data-installation-action="report" data-id="${item.id}">PDF</button>
     </td>
    </tr>`;
  }).join("")
  : `<tr><td colspan="9">${emptyMessage("Nenhum serviço encontrado.")}</td></tr>`;

 document.querySelectorAll("[data-installation-action]").forEach((button) => {
  button.addEventListener("click", () => handleInstallationAction(button.dataset.installationAction, button.dataset.id));
 });
}

function saveInstallation(event) {
 event.preventDefault();
 const id = els.installationId.value || crypto.randomUUID();
 const existing = state.installations.find((item) => item.id === id);
 const project = state.projects.find((item) => item.id === els.installationProject.value);
 if (installationRequiresProject(els.installationServiceType.value) && !project) {
  toast("Selecione um projeto ganho para controlar a instalação.");
  return;
 }
 if (!project && !els.installationCustomer.value) {
  toast("Selecione um cliente para servi\u00e7o sem projeto.");
  return;
 }
 const data = {
  id,
  projectId: els.installationProject.value,
  customerId: els.installationCustomer.value || project.customerId || "",
  serviceType: els.installationServiceType.value,
  status: els.installationStatus.value,
  closedDate: els.installationClosedDate.value,
  postSaleDueDate: els.installationPostSaleDueDate.value || addBusinessDaysIso(els.installationClosedDate.value || todayIso, 2),
  postSaleContactedAt: els.installationPostSaleContactedAt.value,
  deadlineDate: els.installationDeadlineDate.value || addBusinessDaysIso(els.installationClosedDate.value || todayIso, 15),
  scheduledDate: els.installationScheduledDate.value,
  completedDate: els.installationCompletedDate.value || (els.installationStatus.value === "concluida" ? todayIso : ""),
  panels: Number(els.installationPanels.value || 0),
  outsourcingCost: Number(els.installationOutsourcingCost.value || 0),
  team: els.installationTeam.value.trim(),
  labor: installationLaborEntriesFromForm(),
  technicalReport: technicalReportFromForm(),
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
 syncProjectFromInstallation(data);
 mirrorSiblingInstallationStatus(data);

 persist("projetos");
 renderAll();
 resetInstallationForm();
 setInstallationFormVisible(false);
 toast("Serviço salvo.");
}

function syncProjectFromInstallation(installation) {
 if (!installation.projectId) return;
 const project = state.projects.find((item) => item.id === installation.projectId);
 if (!project) return;
 const status = normalizeInstallationStatus(installation.status);
 if (status === "concluida") {
  project.status = "concluido";
  project.endDate = project.endDate || installation.completedDate || todayIso;
  project.updatedAt = installation.updatedAt || new Date().toISOString();
 }
}

function mirrorSiblingInstallationStatus(installation) {
 if (!installation.projectId || !installation.serviceType) return;
 state.installations.forEach((item) => {
  if (item.id === installation.id) return;
  if (item.projectId !== installation.projectId) return;
  if ((item.serviceType || "instalacao_projeto") !== installation.serviceType) return;
  if (normalizeInstallationStatus(item.status) === "cancelada") return;
  item.status = installation.status;
  item.completedDate = installation.completedDate;
  item.updatedAt = installation.updatedAt;
 });
}

function deleteCurrentInstallation() {
 const id = els.installationId.value;
 if (!id) return;
 const installation = state.installations.find((item) => item.id === id);
 if (!installation) return;
 const label = projectName(installation.projectId) || personName(installation.customerId) || "este serviço";
 const confirmed = window.confirm(`Deseja excluir o serviço/instalação "${label}"\n\nEssa ação remove apenas o registro da instalação. Cliente, projeto, financeiro e estoque não ser?o apagados.`);
 if (!confirmed) return;

 state.installations = state.installations.filter((item) => item.id !== id);
 state.opportunities.forEach((opportunity) => {
  if (opportunity.installationId === id) opportunity.installationId = "";
 });

 persist(["projetos", "vendas"]);
 renderAll();
 resetInstallationForm();
 setInstallationFormVisible(false);
 toast("Serviço exclu?do.");
}

function handleInstallationAction(action, id) {
 const installation = state.installations.find((item) => item.id === id);
 if (!installation) return;
 if (action === "edit") {
  setInstallationFormVisible(true);
  els.installationId.value = installation.id;
  els.deleteInstallationBtn.classList.remove("hidden");
  els.installationProject.value = installation.projectId;
  els.installationCustomer.value = installation.customerId;
  els.installationServiceType.value = installation.serviceType || "instalacao_projeto";
  els.installationStatus.value = normalizeInstallationStatus(installation.status);
  els.installationClosedDate.value = installation.closedDate || (installation.createdAt || "").slice(0, 10) || todayIso;
  els.installationPostSaleDueDate.value = installation.postSaleDueDate || addBusinessDaysIso(els.installationClosedDate.value, 2);
  els.installationPostSaleContactedAt.value = installation.postSaleContactedAt || "";
  els.installationDeadlineDate.value = installation.deadlineDate || addBusinessDaysIso(els.installationClosedDate.value, 15);
  els.installationScheduledDate.value = installation.scheduledDate;
  els.installationCompletedDate.value = installation.completedDate || "";
  els.installationPanels.value = installation.panels || "";
  if (els.installationOutsourcingCost) els.installationOutsourcingCost.value = installation.outsourcingCost || "";
  els.installationTeam.value = installation.team;
  renderInstallationLaborRows(installation.labor || []);
  setTechnicalReportForm(installation.technicalReport || {}, installation.serviceType || "instalacao_projeto");
  els.installationMaterials.value = installation.materials;
  els.installationNotes.value = installation.notes;
  els.installationConclusion.value = installation.conclusion;
  updateInstallationFormCalculations();
  scrollToInstallationForm();
  return;
 }
 if (action === "complete") {
  installation.status = "concluida";
  installation.completedDate = installation.completedDate || todayIso;
  installation.technicalReport = {
   ...(installation.technicalReport || {}),
   warrantyStartDate: installation.technicalReport.warrantyStartDate || installation.completedDate,
  };
  installation.updatedAt = new Date().toISOString();
  syncProjectFromInstallation(installation);
  mirrorSiblingInstallationStatus(installation);
  persist("projetos");
  renderAll();
  toast("Serviço concluído.");
 }
 if (action === "report") {
  generateTechnicalDeliveryPdf(installation);
 }
}

function renderProjectReports() {
 const summaries = state.projects.map(projectSummary);
 const selectedId = els.projectReportSelect.value || state.projects[0].id || "";
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
 const expectedResult = Number(project.contractValue || 0) - Number(project.expectedCosts || 0);
 const realizedResult = received - paid;
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
  expectedResult,
  realizedResult,
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
   .map((allocation) => ({ transaction, amount: allocation.amount, kind: "transaction", refId: transaction.id }));
 });

 const bankEntries = state.bankMovements
  .filter((movement) => !movement.transactionId)
  .flatMap((movement) => {
   const allocations = normalizeAllocations(movement);
   return allocations
    .filter((allocation) => allocation.projectId === projectId)
    .map((allocation) => ({
     transaction: {
      type: movement.type === "entrada" ? "receber" : "pagar",
      status: movement.type === "entrada" ? "recebido" : "pago",
      category: movement.category || "Banco",
      description: movement.description,
      dueDate: movement.date,
      paidDate: movement.date,
     },
     amount: allocation.amount,
     kind: "bank",
     refId: movement.id,
    }));
  });

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
 document.querySelector("#projectReceivedSmall").textContent = `${money(summary.received)} recebido ? ${money(summary.receivable)} a receber`;
 document.querySelector("#projectCosts").textContent = money(summary.costs);
 document.querySelector("#projectPaidSmall").textContent = `${money(summary.paid)} pago ? ${money(summary.payable)} a pagar`;
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
  ["Resultado previsto", summary.expectedResult],
  ["Resultado realizado", summary.realizedResult],
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
   const row = rows.get(key) || { category: key, total: 0, count: 0, entries: [] };
   row.total += entry.amount;
   row.count += 1;
   row.entries.push(entry);
   rows.set(key, row);
  });

 const sorted = [...rows.values()].sort((a, b) => b.total - a.total);
 document.querySelector("#projectCategoryCosts").innerHTML = sorted.length ?
   sorted.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.category)}</span><span>${money(row.total)}</span></strong>
    <span class="muted">${row.count} lan?amento(s)</span>
    <div class="category-cost-entries">
     ${row.entries
      .map(
       (entry) => `
      <button type="button" class="category-cost-entry" data-view-${entry.kind === "bank" ? "bank" : "transaction"}="${entry.refId}">
       <span>${escapeHtml(entry.transaction.description || "Sem descrição")}${entry.kind === "bank" ? " ? movimento banc?rio" : ""}</span>
       <span class="muted">${formatDate(entry.transaction.dueDate)}</span>
       <span class="money">${money(entry.amount)}</span>
      </button>`
      )
      .join("")}
    </div> ?
   </article>`).join("")
  : emptyMessage("Sem custos vinculados ao projeto.");

 document.querySelectorAll("#projectCategoryCosts [data-view-transaction]").forEach((button) => {
  button.addEventListener("click", () => handleTransactionAction("edit", button.dataset.viewTransaction));
 });
 document.querySelectorAll("#projectCategoryCosts [data-view-bank]").forEach((button) => {
  button.addEventListener("click", () => handleBankAction("classify", button.dataset.viewBank));
 });
}

function renderProjectComparison(summaries) {
 document.querySelector("#projectComparisonTable").innerHTML = summaries.length ?
   summaries.map((summary) => `
   <tr>
    <td>${escapeHtml(projectLabel(summary.project))}</td>
    <td class="money">${money(summary.invoiced)}</td>
    <td class="money">${money(summary.costs)}</td>
    <td class="money">${money(summary.grossResult)}</td>
    <td>${summary.marginPercent.toFixed(1)}%</td>
    <td>${projectStatusLabel(summary.project.status)}</td> ?
   </tr>`).join("")
  : `<tr><td colspan="6">${emptyMessage("Nenhum projeto cadastrado.")}</td></tr>`;
}

function renderProfitableProjects(summaries) {
 const rows = [...summaries].sort((a, b) => b.grossResult - a.grossResult).slice(0, 5);
 document.querySelector("#profitableProjects").innerHTML = rows.length ?
   rows.map((summary) => `
   <article class="report-item">
    <strong><span>${escapeHtml(projectLabel(summary.project))}</span><span>${money(summary.grossResult)}</span></strong>
    <span class="muted">${summary.marginPercent.toFixed(1)}% de margem</span> ?
   </article>`).join("")
  : emptyMessage("Nenhum projeto para comparar.");
}

function renderLowMarginProjects(summaries) {
 const rows = summaries
  .filter((summary) => summary.invoiced > 0 && summary.marginPercent < Number(summary.project.targetMargin || 0))
  .sort((a, b) => a.marginPercent - b.marginPercent);

 document.querySelector("#lowMarginProjects").innerHTML = rows.length ?
   rows.map((summary) => `
   <article class="report-item">
    <strong><span>${escapeHtml(projectLabel(summary.project))}</span><span>${summary.marginPercent.toFixed(1)}%</span></strong>
    <span class="muted">Meta: ${Number(summary.project.targetMargin || 0).toFixed(1)}% ? Resultado ${money(summary.grossResult)}</span> ?
   </article>`).join("")
  : emptyMessage("Nenhum projeto abaixo da margem esperada.");
}

function renderUnallocatedExpenses() {
 const rows = state.transactions
  .filter((transaction) => transaction.type === "pagar" && !normalizeAllocations(transaction).length)
  .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  .slice(0, 20);

 document.querySelector("#unallocatedExpenses").innerHTML = rows.length ?
   rows.map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${escapeHtml(item.category)} ? ${statusLabel(item.status)}</span> ?
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
 const blocks = [...normalized.matchAll(/<STMTTRN>([\s\S]*)(=<STMTTRN>|<\/BANKTRANLIST>|<\/CREDITCARDMSGSRSV1>|$)/gi)].map((match) => match[1]);

 if (!blocks.length) {
  throw new Error("OFX sem movimentos");
 }

 const occurrences = new Map();
 const movements = blocks.map((block) => {
  const amount = Number((tagValue(block, "TRNAMT") || "0").replace(",", "."));
  const date = parseOfxDate(tagValue(block, "DTPOSTED"));
  const memo = [tagValue(block, "NAME"), tagValue(block, "MEMO")].filter(Boolean).join(" - ") || "Movimento banc?rio";
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
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accountId: account.accountId, bankId: account.bankId, start, end }),
 });
 const result = await response.json();
 if (!result.ok) throw new Error(result.error || "Falha ao buscar extrato no backend.");

 const accountKey = account.accountKey || `${account.bankId}-${account.accountId}`;
 if (result.balance && Number.isFinite(Number(result.balance.amount))) {
  account.balance = Number(result.balance.amount);
  account.balanceDate = result.balance.date || end;
  account.source = `${bankKey}_api`;
  account.updatedAt = new Date().toISOString();
 }
 if (result.investments && Number.isFinite(Number(result.investments.amount))) {
  account.investmentBalance = Number(result.investments.amount);
  account.investmentDate = result.investments.date || end;
  account.investmentSource = `${bankKey}_api`;
  account.updatedAt = new Date().toISOString();
 }
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
  description: cleanText(raw.description || "Movimento banc?rio"),
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
 els.bankSyncList.innerHTML = accounts.length ?
   accounts.map((account) => {
    const provider = BANK_PROVIDERS[account.syncProvider] || BANK_PROVIDERS.mock;
    const lastSync = account.lastSyncedAt ? `Ãšltima sincronização: ${new Date(account.lastSyncedAt).toLocaleString("pt-BR")}` : "Nunca sincronizado por API";
    return `
   <article class="bank-sync-item">
    <div>
     <strong>${escapeHtml(account.bankId)} ? Conta ${escapeHtml(account.accountId || "não identificada")}</strong>
     <span class="muted">${escapeHtml(provider.label)} ? ${lastSync}</span>
    </div>
    <button class="secondary-btn" type="button" data-sync-account="${escapeHtml(account.accountKey || `${account.bankId}-${account.accountId}`)}">Sincronizar extrato</button>
   </article>`;
   }).join("")
  : emptyMessage("Importe um OFX ao menos uma vez para cadastrar uma conta antes de sincronizar por API.");

 document.querySelectorAll("[data-sync-account]").forEach((button) => {
  button.addEventListener("click", () => openBankSyncDialog(button.dataset.syncAccount));
 });
}

function bankAccountDisplayName(account) {
 if (!account) return "Conta não encontrada";
 return `${account.bankId || "Banco"} ? Conta ${account.accountId || "não identificada"}`;
}

function hydrateBankApiAccountOptions() {
 const current = els.bankApiAccount.value;
 const accounts = latestBankAccounts();
 els.bankApiAccount.innerHTML = accounts.length ?
   accounts.map((account) => {
    const key = account.accountKey || `${account.bankId}-${account.accountId}`;
    return `<option value="${escapeHtml(key)}">${escapeHtml(bankAccountDisplayName(account))}</option>`;
   }).join("")
  : `<option value="">Importe um OFX para cadastrar a conta primeiro</option>`;
 if (accounts.some((account) => (account.accountKey || `${account.bankId}-${account.accountId}`) === current)) {
  els.bankApiAccount.value = current;
 }
}

function accountByKey(accountKey) {
 return state.bankAccounts.find((account) => (account.accountKey || `${account.bankId}-${account.accountId}`) === accountKey);
}

function resetBankApiForm() {
 els.bankApiForm.reset();
 els.bankApiConfigId.value = "";
 els.bankApiProvider.value = "inter";
 els.bankApiLookbackDays.value = 1;
 els.bankApiAutoDaily.checked = true;
 els.bankApiActive.checked = true;
 hydrateBankApiAccountOptions();
}

function saveBankApiConfig(event) {
 event.preventDefault();
 if (!guardViewAccess("apisbancarias")) return;
 const accountKey = els.bankApiAccount.value;
 const account = accountByKey(accountKey);
 if (!account) {
  toast("Importe um OFX para cadastrar a conta antes de configurar a API.");
  return;
 }

 const id = els.bankApiConfigId.value || crypto.randomUUID();
 const existing = state.bankApiConfigs.find((config) => config.id === id);
 const duplicate = state.bankApiConfigs.some((config) => config.id !== id && config.provider === els.bankApiProvider.value && config.accountKey === accountKey);
 if (duplicate) {
  toast("J? existe configuração dessa API para essa conta.");
  return;
 }

 const config = {
  id,
  provider: els.bankApiProvider.value,
  accountKey,
  endpoint: els.bankApiEndpoint.value.trim(),
  lookbackDays: Math.max(1, Math.min(90, Number(els.bankApiLookbackDays.value || 1))),
  autoDaily: els.bankApiAutoDaily.checked,
  active: els.bankApiActive.checked,
  lastSyncedAt: existing.lastSyncedAt || "",
  lastAutoSyncDate: existing.lastAutoSyncDate || "",
  lastResult: existing.lastResult || "",
  notes: els.bankApiNotes.value.trim(),
  createdAt: existing.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
 };

 const index = state.bankApiConfigs.findIndex((item) => item.id === id);
 if (index >= 0) state.bankApiConfigs[index] = config;
 else state.bankApiConfigs.push(config);

 applyBankApiConfigToAccount(config);
 persist();
 renderAll();
 resetBankApiForm();
 toast("Configuração de API banc?ria salva.");
}

function applyBankApiConfigToAccount(config) {
 const account = accountByKey(config.accountKey);
 if (!account) return;
 account.syncProvider = config.provider;
 account.syncEndpoint = config.endpoint;
}

function updateBankApiSyncResult(account, providerKey, { added, duplicates }) {
 const accountKey = account.accountKey || `${account.bankId}-${account.accountId}`;
 const config = state.bankApiConfigs.find((item) => item.accountKey === accountKey && item.provider === providerKey);
 if (!config) return;
 config.lastSyncedAt = new Date().toISOString();
 config.lastResult = `${added} importado(s), ${duplicates} duplicado(s) ignorado(s)`;
}

function renderBankApiConfigs() {
 hydrateBankApiAccountOptions();
 const rows = [...state.bankApiConfigs].sort((a, b) => a.provider.localeCompare(b.provider) || a.accountKey.localeCompare(b.accountKey));
 els.bankApiConfigList.innerHTML = rows.length ?
   rows.map((config) => {
    const account = accountByKey(config.accountKey);
    const provider = BANK_PROVIDERS[config.provider] || { label: config.provider };
    return `
   <article class="report-item">
    <strong><span>${escapeHtml(provider.label)} ? ${escapeHtml(bankAccountDisplayName(account))}</span><span>${config.active ? "Ativa" : "Inativa"}</span></strong>
    <span class="muted">${config.autoDaily ? `Autom?tico di?rio ? ?ltimos ${config.lookbackDays} dia(s)` : "Autom?tico desligado"} ? ${config.lastSyncedAt ? `Ãšltima baixa: ${new Date(config.lastSyncedAt).toLocaleString("pt-BR")}` : "Nunca baixou extrato"}</span>
    <span class="muted">${escapeHtml(config.lastResult || config.notes || "Credenciais protegidas no backend seguro.")}</span>
    <div class="row-actions">
     <button type="button" data-bank-api-action="sync" data-id="${config.id}">Baixar agora</button>
     <button type="button" data-bank-api-action="edit" data-id="${config.id}">Editar</button>
     <button type="button" data-bank-api-action="delete" data-id="${config.id}">Excluir</button>
    </div>
   </article>`;
   }).join("")
  : emptyMessage("Nenhuma API banc?ria configurada.");

 document.querySelectorAll("[data-bank-api-action]").forEach((button) => {
  button.addEventListener("click", () => handleBankApiAction(button.dataset.bankApiAction, button.dataset.id));
 });
}

function handleBankApiAction(action, id) {
 const config = state.bankApiConfigs.find((item) => item.id === id);
 if (!config) return;
 if (action === "sync") {
  syncBankApiConfig(config, { manual: true });
  return;
 }
 if (action === "edit") {
  els.bankApiConfigId.value = config.id;
  els.bankApiProvider.value = config.provider;
  hydrateBankApiAccountOptions();
  els.bankApiAccount.value = config.accountKey;
  els.bankApiEndpoint.value = config.endpoint;
  els.bankApiLookbackDays.value = config.lookbackDays;
  els.bankApiAutoDaily.checked = config.autoDaily;
  els.bankApiActive.checked = config.active;
  els.bankApiNotes.value = config.notes;
  setView("apisbancarias");
  els.bankApiForm.scrollIntoView({ behavior: "smooth", block: "start" });
  return;
 }
 if (action === "delete") {
  state.bankApiConfigs = state.bankApiConfigs.filter((item) => item.id !== id);
  persist();
  renderAll();
  toast("Configuração removida.");
 }
}

function syncBankApiConfigFromForm() {
 if (!guardViewAccess("apisbancarias")) return;
 const accountKey = els.bankApiAccount.value;
 const account = accountByKey(accountKey);
 if (!account) {
  toast("Selecione uma conta cadastrada por OFX.");
  return;
 }
 const config = {
  id: els.bankApiConfigId.value || "form-preview",
  provider: els.bankApiProvider.value,
  accountKey,
  endpoint: els.bankApiEndpoint.value.trim(),
  lookbackDays: Math.max(1, Math.min(90, Number(els.bankApiLookbackDays.value || 1))),
  autoDaily: els.bankApiAutoDaily.checked,
  active: els.bankApiActive.checked,
  notes: els.bankApiNotes.value.trim(),
 };
 syncBankApiConfig(config, { manual: true });
}

async function syncBankApiConfig(config, { manual = false, auto = false } = {}) {
 if (!config.active && !manual) return;
 const account = accountByKey(config.accountKey);
 if (!account) {
  if (manual) toast("Conta banc?ria não encontrada para essa configuração.");
  return;
 }

 applyBankApiConfigToAccount(config);
 const provider = BANK_PROVIDERS[config.provider];
 if (!provider || !provider.fetchStatement) {
  if (manual) toast("Provedor banc?rio ainda não implementado.");
  return;
 }
 if (provider.requiresEndpoint && !config.endpoint) {
  if (manual) toast("Informe a URL do backend seguro para essa API.");
  return;
 }

 const end = todayIso;
 const start = toIso(addDays(today, -Math.max(1, Number(config.lookbackDays || 1)) + 1));
 try {
  const movements = await provider.fetchStatement(account, { start, end });
  const { added, duplicates } = mergeBankMovements(movements);
  const stored = state.bankApiConfigs.find((item) => item.id === config.id);
  if (stored) {
   stored.lastSyncedAt = new Date().toISOString();
   if (auto) stored.lastAutoSyncDate = todayIso;
   stored.lastResult = `${added} importado(s), ${duplicates} duplicado(s) ignorado(s)`;
   applyBankApiConfigToAccount(stored);
  }
  account.lastSyncedAt = new Date().toISOString();
  persist();
  renderAll();
  if (manual) toast(`${added} movimento(s) importado(s). ${duplicates} duplicado(s) ignorado(s).`);
 } catch (error) {
  console.error(error);
  const stored = state.bankApiConfigs.find((item) => item.id === config.id);
  if (stored) {
   stored.lastResult = error.message || "Falha ao baixar extrato";
   persist();
   renderBankApiConfigs();
  }
  if (manual) toast(error.message || "Não foi possível baixar o extrato.");
 }
}

function runDailyBankApiSync() {
 if (bankApiAutoSyncRunning) return;
 const due = state.bankApiConfigs.filter((config) => config.active && config.autoDaily && config.lastAutoSyncDate !== todayIso);
 if (!due.length) return;
 bankApiAutoSyncRunning = true;
 Promise.allSettled(due.map((config) => syncBankApiConfig(config, { auto: true }))).finally(() => {
  bankApiAutoSyncRunning = false;
 });
}

function openBankSyncDialog(accountKey) {
 const account = state.bankAccounts.find((item) => (item.accountKey || `${item.bankId}-${item.accountId}`) === accountKey);
 if (!account) return;

 els.bankSyncForm.reset();
 els.bankSyncAccountKey.value = accountKey;
 els.bankSyncTitle.textContent = `Sincronizar extrato ? ${account.bankId} ? Conta ${account.accountId || ""}`;
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
 els.bankSyncHint.textContent = provider.requiresEndpoint ? "Esse provedor chama um backend pr?prio (que voc? hospeda) respons?vel por conversar com o banco de verdade ? o site não guarda nem envia credenciais."
  : "Gera movimentos de teste determin?sticos para o per?odo escolhido, ?til para validar deduplicação e conciliação antes de conectar a API real.";
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
  toast("Informe um per?odo v?lido para sincronizar.");
  return;
 }

 account.syncProvider = providerKey;
 account.syncEndpoint = els.bankSyncEndpoint.value.trim();

 els.bankSyncSubmit.disabled = true;
 els.bankSyncSubmit.textContent = "Buscando?";
 try {
  const movements = await provider.fetchStatement(account, { start, end });
  const { added, duplicates } = mergeBankMovements(movements);
  account.lastSyncedAt = new Date().toISOString();
  updateBankApiSyncResult(account, providerKey, { added, duplicates });
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
 hydrateBankAccountFilter();
 const movements = filteredBankMovements();
 const totalIn = sum(movements.filter((item) => item.type === "entrada"));
 const totalOut = sum(movements.filter((item) => item.type === "saida"));
 const pending = movements.filter((item) => bankStatus(item) === "pendente").length;

 document.querySelector("#bankInTotal").textContent = money(totalIn);
 document.querySelector("#bankOutTotal").textContent = money(totalOut);
 document.querySelector("#bankNetTotal").textContent = money(totalIn - totalOut);
 document.querySelector("#bankPendingCount").textContent = String(pending);
 document.querySelector("#bankInCount").textContent = `${movements.filter((item) => item.type === "entrada").length} movimentos`;
 document.querySelector("#bankOutCount").textContent = `${movements.filter((item) => item.type === "saida").length} movimentos`;

 document.querySelector("#bankTable").innerHTML = movements.length ?
   movements.map(bankRow).join("")
  : `<tr><td colspan="8">${emptyMessage("Nenhum movimento banc?rio encontrado.")}</td></tr>`;

 document.querySelectorAll("[data-bank-action]").forEach((button) => {
  button.addEventListener("click", () => handleBankAction(button.dataset.bankAction, button.dataset.id));
 });
}

function bankAccountKey(item) {
 return `${item.bankId || ""}|${item.accountId || ""}`;
}

function hydrateBankAccountFilter() {
 const current = els.bankAccountFilter.value;
 const accounts = new Map();
 state.bankMovements.forEach((item) => {
  const key = bankAccountKey(item);
  if (!accounts.has(key)) accounts.set(key, { bankId: item.bankId || "Banco não identificado", accountId: item.accountId });
 });
 const sorted = [...accounts.entries()].sort((a, b) => a[1].bankId.localeCompare(b[1].bankId) || String(a[1].accountId).localeCompare(String(b[1].accountId)));
 els.bankAccountFilter.innerHTML =
  `<option value="todas">Todas as contas</option>` +
  sorted.map(([key, acc]) => `<option value="${escapeHtml(key)}">${escapeHtml(acc.bankId)} ? Conta ${escapeHtml(acc.accountId || "não identificada")}</option>`).join("");
 els.bankAccountFilter.value = accounts.has(current) ? current : "todas";
}

function filteredBankMovements() {
 const search = els.bankSearch.value.toLowerCase().trim();
 const status = els.bankStatus.value;
 const accountFilter = els.bankAccountFilter.value;
 const start = els.bankDateStart.value;
 const end = els.bankDateEnd.value;
 const month = els.bankMonthFilter.value;
 const year = String(els.bankYearFilter.value || "").trim();
 return state.bankMovements
  .filter((item) => {
   const haystack = `${item.description} ${item.bankId} ${item.accountId} ${item.documentNumber} ${item.category} ${bankMovementProjectLabel(item)}`.toLowerCase();
   return (
    (!search || haystack.includes(search)) &&
    (status === "todos" || bankStatus(item) === status) &&
    (accountFilter === "todas" || bankAccountKey(item) === accountFilter) &&
    matchesBankDateFilters(item, { start, end, month, year })
   );
  })
  .sort((a, b) => b.date.localeCompare(a.date));
}

function matchesBankDateFilters(item, filters) {
 const date = item.date || "";
 if (!date) return false;
 if (filters.start && date < filters.start) return false;
 if (filters.end && date > filters.end) return false;
 if (filters.month && date.slice(5, 7) !== filters.month) return false;
 if (filters.year && date.slice(0, 4) !== filters.year) return false;
 return true;
}

function bankRow(item) {
 return `
  <tr>
   <td>${formatDate(item.date)}</td>
   <td>${item.type === "entrada" ? "Entrada" : "Saída"}</td>
   <td>
    <strong>${escapeHtml(item.description)}</strong>
    <span class="muted block">${escapeHtml(item.bankId)} ? ${escapeHtml(item.documentNumber || item.fitid)} ? ${escapeHtml(bankMovementProjectLabel(item))}</span>
   </td>
   <td>${escapeHtml(item.category || "-")}</td>
   <td>${dreGroupLabel(item.dreGroup)}</td>
   <td>${bankStatusBadge(item)}</td>
   <td class="money${item.type === "saida" ? " money-negative" : ""}">${money(item.type === "saida" ? -item.amount : item.amount)}</td>
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
  movement.updatedAt = new Date().toISOString();
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
 refreshSearchableSelect(els.bankProject);
 renderBankAllocationRows(normalizeAllocations(movement));
 els.bankNotes.value = movement.notes || "";
 els.bankMovementSummary.innerHTML = `
  <strong>${movement.type === "entrada" ? "Entrada" : "Saída"} de ${money(movement.amount)}</strong>
  <span>${formatDate(movement.date)} ? ${escapeHtml(movement.description)}</span>`;
 hydrateBankMatches(movement);
 els.bankMatchTransaction.value = movement.transactionId || "";
 els.bankMatchTransaction.onchange = () => {
  if (!els.bankProject.value) {
   const transaction = state.transactions.find((item) => item.id === els.bankMatchTransaction.value);
   const allocations = transaction ? normalizeAllocations(transaction) : [];
   if (allocations.length === 1) {
    els.bankProject.value = allocations[0].projectId;
    refreshSearchableSelect(els.bankProject);
    renderBankAllocationRows([]);
   }
  }
 };
 hydrateBankInvoiceMatches(movement);
 els.bankMatchInvoice.value = movement.invoiceId || "";
 els.bankDialog.showModal();
}

function bankAllocationProjectOptions(selectedId = "") {
 return state.projects.length ?
   state.projects.map((project) => `<option value="${project.id}" ${project.id === selectedId ? "selected" : ""}>${escapeHtml(projectLabel(project))}</option>`).join("")
  : `<option value="">Cadastre um projeto primeiro</option>`;
}

function renderBankAllocationRows(allocations = []) {
 if (!els.bankAllocationRows) return;
 els.bankAllocationRows.innerHTML = "";
 allocations.slice(0, 10).forEach((allocation) => addBankAllocationRow(allocation));
 renderBankAllocationTotal();
}

function addBankAllocationRow(allocation = {}) {
 if (!els.bankAllocationRows) return;
 if (els.bankAllocationRows.children.length >= 10) {
  toast("O rateio permite no m?ximo 10 lan?amentos por movimento.");
  return;
 }
 const row = document.createElement("div");
 row.className = "allocation-row";
 row.innerHTML = `
  <select data-bank-allocation-project>${bankAllocationProjectOptions(allocation.projectId)}</select>
  <input data-bank-allocation-amount type="number" min="0.01" step="0.01" placeholder="Valor" />
  <button class="secondary-btn" data-remove-bank-allocation type="button">Remover</button>`;
 els.bankAllocationRows.appendChild(row);
 row.querySelector("[data-bank-allocation-amount]").value = allocation.amount || "";
 row.querySelector("[data-bank-allocation-project]").addEventListener("change", renderBankAllocationTotal);
 row.querySelector("[data-bank-allocation-amount]").addEventListener("input", renderBankAllocationTotal);
 row.querySelector("[data-remove-bank-allocation]").addEventListener("click", () => {
  row.remove();
  renderBankAllocationTotal();
 });
 renderBankAllocationTotal();
}

function getBankAllocations() {
 if (!els.bankAllocationRows) return [];
 return [...els.bankAllocationRows.querySelectorAll(".allocation-row")]
  .map((row) => ({
   projectId: row.querySelector("[data-bank-allocation-project]").value,
   amount: roundCurrency(Number(row.querySelector("[data-bank-allocation-amount]").value || 0)),
  }))
  .filter((allocation) => allocation.projectId && allocation.amount > 0);
}

function currentBankMovementAmount() {
 const movement = state.bankMovements.find((item) => item.id === els.bankMovementId.value);
 return roundCurrency(Number(movement.amount || 0));
}

function renderBankAllocationTotal() {
 if (!els.bankAllocationTotal) return;
 const total = allocationTotal(getBankAllocations());
 const movementAmount = currentBankMovementAmount();
 const diff = roundCurrency(movementAmount - total);
 els.bankAllocationTotal.textContent = `Total rateado: ${money(total)} ? Diferen?a: ${money(diff)}`;
 els.bankAllocationTotal.classList.toggle("invalid", total > 0 && Math.abs(diff) >= 0.01);
}

function createProjectFromBankDialog() {
 if (!guardViewAccess("projetos")) return;
 const movement = state.bankMovements.find((item) => item.id === els.bankMovementId.value);
 const suggestedName = movement.description ? movement.description.slice(0, 80) : "";
 quickProjectTarget = "bank";
 hydrateProjectOptions();
 els.quickProjectForm.reset();
 els.quickProjectName.value = suggestedName;
 els.quickProjectCustomer.value = "";
 els.quickProjectStatus.value = "ativo";
 els.quickProjectStartDate.value = todayIso;
 els.quickProjectContractValue.value = movement.type === "entrada" ? Number(movement.amount || 0) : 0;
 els.quickProjectExpectedCosts.value = movement.type === "saida" ? Number(movement.amount || 0) : 0;
 els.quickProjectTargetMargin.value = 20;
 els.quickProjectNotes.value = movement ? `Criado a partir da conciliacao bancaria: ${movement.description}` : "Criado a partir da conciliacao bancaria.";
 els.quickProjectDialog.showModal();
 els.quickProjectName.focus();
}

function hydrateBankInvoiceMatches(movement) {
 const wantKinds = movement.type === "entrada" ? ["servico", "material"] : ["despesa"];
 const matches = state.invoices
  .filter((item) => wantKinds.includes(item.kind))
  .filter((item) => item.status !== "cancelada")
  .map((item) => ({ item, score: invoiceMatchScore(movement, item) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 50);

 els.bankMatchInvoice.innerHTML = [
  `<option value="">Sem vínculo com NF</option>`,
  ...matches.map(
   ({ item, score }) =>
    `<option value="${item.id}">NF ${escapeHtml(item.number)} ? ${escapeHtml(personName(item.personId))} ? valor cont?bil ${money(item.accountingValue)}${score >= 0 ? " ? valor compatével" : ""}</option>`
  ),
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
  ...matches.map(({ item }) => `<option value="${item.id}">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${escapeHtml(item.description)} ? ${escapeHtml(transactionProjectLabel(item))} ? ${money(item.amount)}</option>`),
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

 movement.category = els.bankCategory.value.trim();
 movement.dreGroup = els.bankDreGroup.value;
 const matchedTransaction = state.transactions.find((item) => item.id === els.bankMatchTransaction.value);
 const validationMessage = validateBankReconciliation(movement, matchedTransaction);
 if (validationMessage) {
  toast(validationMessage);
  return;
 }
 const bankAllocations = getBankAllocations();
 if (bankAllocations.length && !validateAllocations(movement.amount, bankAllocations)) {
  toast("A soma do rateio precisa ser igual ao valor total do movimento banc?rio.");
  return;
 }
 unlinkBankMovement(movement);
 const matchedAllocations = matchedTransaction ? normalizeAllocations(matchedTransaction) : [];
 movement.allocations = bankAllocations.length ?
   bankAllocations
  : els.bankProject.value ?
    [{ projectId: els.bankProject.value, amount: roundCurrency(Number(movement.amount || 0)) }]
   : matchedAllocations;
 movement.projectId = movement.allocations.length === 1 ? movement.allocations[0].projectId : "";
 movement.notes = els.bankNotes.value.trim();
 movement.transactionId = els.bankMatchTransaction.value;
 movement.updatedAt = new Date().toISOString();

 if (movement.transactionId) {
  const transaction = matchedTransaction;
  if (transaction) {
   transaction.status = transaction.type === "receber" ? "recebido" : "pago";
   transaction.paidDate = movement.date;
   transaction.category = movement.category || transaction.category;
   transaction.dreGroup = movement.dreGroup || transaction.dreGroup;
   transaction.allocations = movement.allocations.length ?
     movement.allocations.map((allocation) => ({ ...allocation }))
    : normalizeAllocations(transaction);
   transaction.projectId = transaction.allocations.length === 1 ? transaction.allocations[0].projectId : "";
   transaction.directProjectCost = transaction.type === "pagar" && Boolean(transaction.allocations.length);
   transaction.bankMovementId = movement.id;
   transaction.updatedAt = movement.updatedAt;
  }
 }
 registerBankReconciliationHistory(movement, matchedTransaction, "conciliado");

 movement.invoiceId = els.bankMatchInvoice.value;
 if (movement.invoiceId) {
  const invoice = state.invoices.find((item) => item.id === movement.invoiceId);
  if (invoice && invoice.status !== "cancelada") {
   invoice.status = invoice.kind === "despesa" ? "paga" : "recebida_total";
   invoice.updatedAt = movement.updatedAt;
  }
 }

 persist();
 renderAll();
 els.bankDialog.close();
 toast("Movimento banc?rio salvo.");
}

function validateBankReconciliation(movement, transaction) {
 if (!transaction) return "";
 const expectedType = movement.type === "entrada" ? "receber" : "pagar";
 if (transaction.type !== expectedType) {
  return movement.type === "entrada" ? "Entrada bancaria so pode conciliar com conta a receber."
   : "Saida bancaria so pode conciliar com conta a pagar.";
 }
 if (Math.abs(Number(movement.amount || 0) - Number(transaction.amount || 0)) > 0.02) {
  return "O valor da movimentacao e diferente do lancamento financeiro.";
 }
 const linkedElsewhere = state.bankMovements.some((item) => item.id !== movement.id && item.transactionId === transaction.id);
 if (linkedElsewhere || (transaction.bankMovementId && transaction.bankMovementId !== movement.id)) {
  return "Este lancamento financeiro ja esta conciliado com outro movimento bancario.";
 }
 if (transaction.status !== "aberto" && transaction.bankMovementId !== movement.id) {
  return "Este lancamento financeiro nao esta em aberto para conciliacao.";
 }
 return "";
}

function registerBankReconciliationHistory(movement, transaction, action) {
 movement.reconciliationHistory = Array.isArray(movement.reconciliationHistory) ? movement.reconciliationHistory : [];
 movement.reconciliationHistory.push({
  id: crypto.randomUUID(),
  action,
  at: new Date().toISOString(),
  user: currentCrmUser(),
  bankId: movement.bankId || "",
  accountId: movement.accountId || "",
  projectId: movement.projectId || transaction.projectId || "",
  transactionId: transaction.id || "",
  amount: Number(movement.amount || 0),
 });
}

function unlinkBankMovement(movement) {
 movement.invoiceId = "";
 if (!movement.transactionId) return;
 const transaction = state.transactions.find((item) => item.id === movement.transactionId);
 if (transaction.bankMovementId === movement.id) {
  transaction.status = "aberto";
  transaction.paidDate = "";
  transaction.bankMovementId = "";
  transaction.updatedAt = new Date().toISOString();
 }
 registerBankReconciliationHistory(movement, transaction, "desfeito");
 movement.transactionId = "";
}

function suggestCategory(movement) {
 const text = movement.description.toLowerCase();
 if (text.includes("pix")) return movement.type === "entrada" ? "Recebimentos PIX" : "Pagamentos PIX";
 if (text.includes("tarifa") || text.includes("taxa")) return "Tarifas banc?rias";
 if (text.includes("salario") || text.includes("folha")) return "Folha";
 if (text.includes("boleto")) return movement.type === "entrada" ? "Recebimento boleto" : "Pagamento boleto";
 return movement.type === "entrada" ? "Receitas financeiras" : "Despesas banc?rias";
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
  bankMovementProjectLabel(item),
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

function stockItemMatchesStatus(item, status) {
 if (!status) return true;
 if (status === "comprar") return item.active && item.quantity < item.minQuantity;
 if (status === "abaixo_minimo") return item.active && item.quantity > 0 && item.quantity < item.minQuantity;
 if (status === "zerado") return item.active && item.quantity <= 0;
 if (status === "inativo") return !item.active;
 if (status === "acima_maximo") return item.active && item.maxQuantity > 0 && item.quantity > item.maxQuantity;
 return true;
}

function stockUserName(id) {
 const user = state.users.find((entry) => entry.id === id);
 return user ? user.name || user.username : "?";
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
  responsibleUserId: currentSessionUser().id || "",
  recipientName: "",
  fromLocationId: "",
  toLocationId: "",
  notes: "",
  createdAt: new Date().toISOString(),
  ...entry,
 });
}

function importIluminarStock(options = {}) {
 const silent = options.silent === true;
 const includeMovements = options.includeMovements !== false;
 const payload = window.ILUMINAR_STOCK_IMPORT;
 if (!payload.items.length) {
  if (!silent) toast("Base da planilha Iluminar não encontrada no sistema.");
  return { changed: false, importedItems: 0, updatedItems: 0, importedMovements: 0 };
 }
 const expectedImportedItems = payload.items.length + (payload.uncatalogedItems || []).length;
 const importedItemsCount = state.stockItems.filter((item) => item.source === payload.sourceFile || item.notes.includes("Controle Estoque Iluminar")).length;
 const alreadyImported = importedItemsCount > 0;
 if (silent && importedItemsCount >= expectedImportedItems) {
  return { changed: false, importedItems: 0, updatedItems: 0, importedMovements: 0 };
 }
 if (alreadyImported && !silent && !window.confirm("A base Iluminar j? parece ter sido importada. Deseja atualizar/mesclar novamente sem duplicar registros")) {
  return { changed: false, importedItems: 0, updatedItems: 0, importedMovements: 0 };
 }

 const mainLocationId = ensureStockLocation("Estoque principal");
 const itemIdByImportId = new Map();
 let importedItems = 0;
 let updatedItems = 0;
 let importedMovements = 0;

 [...payload.items, ...(payload.uncatalogedItems || [])].forEach((sourceItem) => {
  const existing = findImportedStockItem(sourceItem);
  const item = {
   id: existing.id || sourceItem.id || crypto.randomUUID(),
   internalCode: sourceItem.internalCode || "",
   barcode: sourceItem.barcode || "",
   name: sourceItem.name || "",
   description: sourceItem.description || sourceItem.name || "",
   category: sourceItem.category || "SEM CATEGORIA",
   subcategory: sourceItem.subcategory || "",
   brand: sourceItem.brand || "",
   model: sourceItem.model || "",
   unit: sourceItem.unit || "unidade",
   primarySupplierId: existing.primarySupplierId || "",
   locationId: mainLocationId,
   quantity: Number(sourceItem.quantity || 0),
   minQuantity: Number(sourceItem.minQuantity || 0),
   maxQuantity: Number(sourceItem.maxQuantity || 0),
   averageCost: Number(sourceItem.averageCost || 0),
   lastPurchaseCost: Number(sourceItem.lastPurchaseCost || sourceItem.averageCost || 0),
   active: sourceItem.active !== false,
   notes: sourceItem.notes || "Importado da planilha Controle Estoque Iluminar.",
   source: sourceItem.source || payload.sourceFile,
   sourceRow: sourceItem.sourceRow || "",
   createdAt: existing.createdAt || new Date().toISOString(),
   updatedAt: new Date().toISOString(),
  };
  const index = state.stockItems.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
   state.stockItems[index] = { ...state.stockItems[index], ...item };
   updatedItems += 1;
  } else {
   state.stockItems.push(item);
   importedItems += 1;
  }
  itemIdByImportId.set(sourceItem.id, item.id);
 });

 if (includeMovements) {
  (payload.movements || []).forEach((movement) => {
   if (state.stockMovements.some((entry) => entry.id === movement.id)) return;
   const itemId = itemIdByImportId.get(movement.itemId) || findStockItemByImportMovement(movement).id || createImportedUncatalogedItem(movement, mainLocationId);
   const item = state.stockItems.find((entry) => entry.id === itemId);
   const supplierId = movement.supplierName ? ensurePersonByName(movement.supplierName, "fornecedor") : "";
   const projectId = movement.projectName ? ensureProjectByName(movement.projectName) : "";
   const unitCost = Number(movement.unitCost || item.averageCost || 0);
   appendStockMovement({
    id: movement.id,
    itemId,
    type: movement.type,
    date: movement.date || todayIso,
    timestamp: new Date().toISOString(),
    quantity: Number(movement.quantity || 0),
    unitCost,
    totalCost: Number(movement.totalCost || 0) || roundCurrency(Number(movement.quantity || 0) * unitCost),
    balanceBefore: 0,
    balanceAfter: item.quantity || 0,
    projectId,
    supplierId,
    invoiceNumber: movement.invoiceNumber || "",
    exitType: movement.exitType || "",
    reason: movement.reason || "",
    recipientName: movement.recipientName || "",
    notes: [movement.notes, movement.source ? `Origem: ${movement.source} linha ${movement.sourceRow || ""}` : ""].filter(Boolean).join(" "),
    createdAt: new Date().toISOString(),
   });
   importedMovements += 1;
  });
 }

 const result = { changed: importedItems > 0 || updatedItems > 0 || importedMovements > 0, importedItems, updatedItems, importedMovements };
 if (!silent) {
  persist();
  renderAll();
  setStockTab("itens");
  toast(`Planilha Iluminar importada: ${importedItems} item(ns), ${updatedItems} atualizado(s), ${importedMovements} movimento(s).`);
 }
 return result;
}

function findImportedStockItem(sourceItem) {
 return state.stockItems.find((item) =>
  item.id === sourceItem.id ||
  (sourceItem.internalCode && item.internalCode === sourceItem.internalCode && item.name === sourceItem.name) ||
  (!sourceItem.internalCode && item.name.toLowerCase() === String(sourceItem.name || "").toLowerCase())
 );
}

function findStockItemByImportMovement(movement) {
 const code = String(movement.itemCode || "").trim();
 const name = String(movement.itemName || "").trim().toLowerCase();
 return state.stockItems.find((item) => (code && item.internalCode === code) || item.name.toLowerCase() === name);
}

function createImportedUncatalogedItem(movement, locationId) {
 const id = `iluminar-mov-item-${crypto.randomUUID()}`;
 state.stockItems.push({
  id,
  internalCode: movement.itemCode && movement.itemCode !== "item não encontrado" ? movement.itemCode : "",
  barcode: "",
  name: movement.itemName || "Item sem cadastro",
  description: movement.itemName || "",
  category: "SEM CADASTRO",
  subcategory: "",
  brand: "",
  model: "",
  unit: stockUnitFromName(movement.itemName),
  primarySupplierId: "",
  locationId,
  quantity: 0,
  minQuantity: 0,
  maxQuantity: 0,
  averageCost: Number(movement.unitCost || 0),
  lastPurchaseCost: Number(movement.unitCost || 0),
  active: true,
  notes: "Criado automaticamente porque apareceu em movimentação importada sem cadastro localizado.",
  source: movement.source || "Controle Estoque Iluminar.xlsx",
  sourceRow: movement.sourceRow || "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
 });
 return id;
}

function ensureStockLocation(name) {
 const existing = state.stockLocations.find((location) => location.name.toLowerCase() === name.toLowerCase());
 if (existing) return existing.id;
 const location = { id: crypto.randomUUID(), name, description: "Local criado pela importação da planilha Iluminar.", active: true };
 state.stockLocations.push(location);
 return location.id;
}

function ensurePersonByName(name, type) {
 const trimmed = String(name || "").trim();
 if (!trimmed) return "";
 const existing = state.people.find((person) => person.name.toLowerCase() === trimmed.toLowerCase());
 if (existing) return existing.id;
 const person = { id: crypto.randomUUID(), type, name: trimmed, document: "", contact: "" };
 state.people.push(person);
 return person.id;
}

function ensureProjectByName(name) {
 const trimmed = String(name || "").trim();
 if (!trimmed) return "";
 const existing = state.projects.find((project) => project.name.toLowerCase() === trimmed.toLowerCase());
 if (existing) return existing.id;
 const project = {
  id: crypto.randomUUID(),
  code: "",
  name: trimmed,
  customerId: "",
  status: "ativo",
  startDate: todayIso,
  endDate: "",
  contractValue: 0,
  expectedCosts: 0,
  targetMargin: 20,
  costCenterId: crypto.randomUUID(),
  notes: "Criado automaticamente pela importação de requisiúes de estoque.",
 };
 state.projects.push(project);
 upsertCostCenter(project);
 return project.id;
}

function importVendas2026Receivables() {
 const payload = window.LUMERIS_VENDAS_2026_IMPORT;
 if (!payload.rows.length) return { changed: false, people: 0, projects: 0, transactions: 0 };

 const counters = { changed: false, people: 0, projects: 0, transactions: 0 };
 payload.rows.forEach((row) => {
  const sourceKey = `${payload.sourceId}:row:${row.row}`;
  const personId = ensureImportedVendasPerson(row, payload.sourceId, counters);
  const projectId = ensureImportedVendasProject(row, personId, payload.sourceId, counters);
  const project = state.projects.find((item) => item.id === projectId);
  const allocationsFor = (amount) => (projectId ? [{ projectId, amount: roundCurrency(amount) }] : []);

  if (Number(row.received || 0) > 0) {
   addImportedVendasTransaction({
    id: deterministicImportId("vendas-2026-tx", `${sourceKey}:recebido`),
    importSourceKey: `${sourceKey}:recebido`,
    personId,
    projectId,
    description: `${row.projectName} - recebido`,
    dueDate: row.date || todayIso,
    amount: row.received,
    status: "recebido",
    paidDate: row.date || todayIso,
    allocations: allocationsFor(row.received),
    notes: importedVendasNotes(row, "Parcela/valor ja recebido na planilha."),
   }, counters);
  }

  if (Number(row.open || 0) > 0) {
   addImportedVendasTransaction({
    id: deterministicImportId("vendas-2026-tx", `${sourceKey}:aberto`),
    importSourceKey: `${sourceKey}:aberto`,
    personId,
    projectId,
    description: `${row.projectName} - saldo a receber`,
    dueDate: row.date || todayIso,
    amount: row.open,
    status: "aberto",
    paidDate: "",
    allocations: allocationsFor(row.open),
    notes: importedVendasNotes(row, "Saldo pendente na planilha."),
   }, counters);
  }

  if (project) upsertCostCenter(project);
 });

 return counters;
}

function ensureImportedVendasPerson(row, sourceId, counters) {
 const name = String(row.customerName || row.name || "Cliente importado").trim();
 const existing = state.people.find((person) => person.name.toLowerCase() === name.toLowerCase());
 if (existing) return existing.id;
 const person = {
  id: deterministicImportId("vendas-2026-person", `${sourceId}:${name}`),
  type: "cliente",
  name,
  document: "",
  contact: "",
  importSource: sourceId,
  createdAt: new Date().toISOString(),
 };
 state.people.push(person);
 counters.people += 1;
 counters.changed = true;
 return person.id;
}

function ensureImportedVendasProject(row, personId, sourceId, counters) {
 const sourceKey = `${sourceId}:row:${row.row}:project`;
 const name = String(row.projectName || row.name || "Projeto importado").trim();
 const existing = state.projects.find((project) => project.importSourceKey === sourceKey || project.name.toLowerCase() === name.toLowerCase());
 if (existing) {
  if (!existing.customerId && personId) existing.customerId = personId;
  if (!existing.contractValue && Number(row.total || 0) > 0) existing.contractValue = Number(row.total || 0);
  if (!existing.costCenterId) existing.costCenterId = deterministicImportId("vendas-2026-cost-center", sourceKey);
  upsertCostCenter(existing);
  return existing.id;
 }
 const project = {
  id: deterministicImportId("vendas-2026-project", sourceKey),
  code: row.code || "",
  name,
  customerId: personId,
  status: Number(row.open || 0) > 0 ? "ativo" : "concluido",
  startDate: row.date || todayIso,
  endDate: Number(row.open || 0) > 0 ? "" : row.date || "",
  contractValue: Number(row.total || row.received || row.open || 0),
  expectedCosts: 0,
  targetMargin: 20,
  costCenterId: deterministicImportId("vendas-2026-cost-center", sourceKey),
  notes: importedVendasNotes(row, "Projeto criado pela importacao da planilha Vendas_2026_2.xlsx."),
  importSource: sourceId,
  importSourceKey: sourceKey,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
 };
 state.projects.push(project);
 upsertCostCenter(project);
 counters.projects += 1;
 counters.changed = true;
 return project.id;
}

function addImportedVendasTransaction(transaction, counters) {
 if (state.transactions.some((item) => item.id === transaction.id || item.importSourceKey === transaction.importSourceKey)) return;
 state.transactions.push({
  type: "receber",
  category: "Venda importada",
  dreGroup: "receita_bruta",
  saleId: "",
  installmentNumber: "",
  installmentTotal: "",
  bankMovementId: "",
  directProjectCost: false,
  invoiceId: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  importSource: "vendas-2026-2",
  ...transaction,
  amount: roundCurrency(transaction.amount),
 });
 counters.transactions += 1;
 counters.changed = true;
}

function importedVendasNotes(row, extra) {
 return [
  extra,
  `Origem: Vendas_2026_2.xlsx, linha ${row.row}.`,
  row.seller ? `Vendedor: ${row.seller}.` : "",
  row.status ? `Status original: ${row.status}.` : "",
 ].filter(Boolean).join(" ");
}

function deterministicImportId(prefix, value) {
 const text = String(value || "");
 let hash = 2166136261;
 for (let index = 0; index < text.length; index += 1) {
  hash ^= text.charCodeAt(index);
  hash = Math.imul(hash, 16777619);
 }
 return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function stockUnitFromName(name) {
 const text = String(name || "").toUpperCase();
 if (text.includes("METRO")) return "metro";
 if (text.includes("PCT") || text.includes("PACOTE")) return "pacote";
 if (text.includes("ROLO")) return "rolo";
 if (text.includes("CAIXA")) return "caixa";
 return "unidade";
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
 const currentStockFilterItem = els.stockFilterItem.value || "";
 const currentStockFilterCategory = els.stockFilterCategory.value || "";
 const suppliers = state.people.filter((person) => person.type === "fornecedor" || person.type === "ambos");
 const supplierOptions = suppliers.length ?
   suppliers.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
  : `<option value="">Cadastre um fornecedor primeiro</option>`;
 els.stockSupplier.innerHTML = `<option value="">Sem fornecedor principal</option>${supplierOptions}`;
 els.stockEntrySupplier.innerHTML = `<option value="">Sem fornecedor</option>${supplierOptions}`;

 els.stockLocation.innerHTML = state.stockLocations
  .filter((location) => location.active)
  .map((location) => `<option value="${location.id}">${escapeHtml(location.name)}</option>`)
  .join("");

 const activeItems = state.stockItems.filter((item) => item.active);
 const itemOptions = activeItems.length ?
   activeItems.map((item) => `<option value="${item.id}">${escapeHtml(stockItemLabel(item))}</option>`).join("")
  : `<option value="">Cadastre um item primeiro</option>`;
 els.stockEntryItem.innerHTML = itemOptions;
 els.stockExitItem.innerHTML = itemOptions;
 els.stockFilterItem.innerHTML = `<option value="">Todos os itens</option>${activeItems.map((item) => `<option value="${item.id}">${escapeHtml(stockItemLabel(item))}</option>`).join("")}`;
 if (currentStockFilterItem) els.stockFilterItem.value = currentStockFilterItem;
 const categories = [...new Set(state.stockItems.map((item) => item.category || "SEM CADASTRO"))].sort((a, b) => a.localeCompare(b));
 els.stockFilterCategory.innerHTML = `<option value="">Todas as categorias</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
 if (currentStockFilterCategory) els.stockFilterCategory.value = currentStockFilterCategory;
 refreshSearchableSelect(els.stockEntryItem);
 refreshSearchableSelect(els.stockExitItem);
 refreshSearchableSelect(els.stockFilterItem);

 const openInvoices = state.invoices.filter((item) => item.kind === "despesa" && item.status !== "cancelada");
 els.stockEntryInvoice.innerHTML = [
  `<option value="">Sem NF vinculada</option>`,
  ...openInvoices.map((item) => `<option value="${item.id}">NF ${escapeHtml(item.number)} ? ${escapeHtml(personName(item.personId))}</option>`),
 ].join("");

 const payables = state.transactions
  .filter((item) => item.type === "pagar")
  .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  .slice(0, 40);
 els.stockEntryTransaction.innerHTML = [
  `<option value="">Sem conta a pagar vinculada</option>`,
  ...payables.map((item) => `<option value="${item.id}">${formatDate(item.dueDate)} ? ${escapeHtml(item.description)} ? ${money(item.amount)}</option>`),
 ].join("");
}

function resetStockItemForm() {
 els.stockItemForm.reset();
 els.stockItemId.value = "";
 els.stockItemFormTitle.textContent = "Novo item";
 els.saveStockItemBtn.textContent = "Salvar item";
 els.cancelStockItemEditBtn.classList.add("hidden");
 els.stockItemForm.classList.remove("editing");
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
  quantity: existing.quantity || 0,
  minQuantity: Number(els.stockMinQuantity.value || 0),
  maxQuantity: Number(els.stockMaxQuantity.value || 0),
  averageCost: existing.averageCost || 0,
  lastPurchaseCost: existing.lastPurchaseCost || 0,
  active: els.stockActive.checked,
  notes: els.stockNotes.value.trim(),
  createdAt: existing.createdAt || new Date().toISOString(),
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
 const selectedItemId = els.stockFilterItem.value;
 const selectedStatus = els.stockFilterStatus.value;
 const selectedCategory = els.stockFilterCategory.value;
 const items = state.stockItems
  .filter((item) => !selectedItemId || item.id === selectedItemId)
  .filter((item) => stockItemMatchesStatus(item, selectedStatus))
  .filter((item) => !selectedCategory || (item.category || "SEM CADASTRO") === selectedCategory)
  .filter((item) =>
   [
    item.internalCode,
    item.barcode,
    item.name,
    item.description,
    item.category,
    item.subcategory,
    item.brand,
    item.model,
   ]
    .join(" ")
    .toLowerCase()
    .includes(search)
  )
  .sort((a, b) => a.name.localeCompare(b.name));

 els.stockItemCount.textContent = `${items.length} de ${state.stockItems.length} item(ns) em estoque`;
 els.stockItemTable.innerHTML = items.length ?
   items.map(stockItemRow).join("")
  : `<tr><td colspan="11">${emptyMessage("Nenhum item cadastrado.")}</td></tr>`;

 document.querySelectorAll("[data-stock-item-action]").forEach((button) => {
  button.addEventListener("click", () => handleStockItemAction(button.dataset.stockItemAction, button.dataset.id));
 });
}

function stockItemRow(item) {
 const totalValue = item.quantity * item.averageCost;
 const alertLevel = stockAlertLevel(item);
 const details = [item.description, item.brand, item.model, item.barcode ? `Barras: ${item.barcode}` : ""].filter(Boolean);
 const categoryDetails = [item.category || "Sem categoria", item.subcategory].filter(Boolean);
 return `
  <tr class="${alertLevel ? `stock-alert-${alertLevel}` : ""}">
   <td class="stock-item-code">${escapeHtml(item.internalCode || "Sem c?digo")}</td>
   <td class="stock-item-description">
    <strong>${escapeHtml(item.name)}</strong>
    <span class="muted block">${escapeHtml(details.join(" ? ") || "Sem descrição complementar")}</span>
   </td>
   <td class="stock-category-cell">${escapeHtml(categoryDetails[0])}${categoryDetails[1] ? `<span class="muted">${escapeHtml(categoryDetails[1])}</span>` : ""}</td>
   <td>${escapeHtml(STOCK_UNIT_LABELS[item.unit] || item.unit)}</td>
   <td class="money">${formatQuantity(item.quantity)}</td>
   <td class="money">${formatQuantity(item.minQuantity)}</td>
   <td class="money">${formatQuantity(item.maxQuantity)}</td>
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
  els.stockItemFormTitle.textContent = `Editar item ? ${item.name}`;
  els.saveStockItemBtn.textContent = "Salvar alteraúes";
  els.cancelStockItemEditBtn.classList.remove("hidden");
  els.stockItemForm.classList.add("editing");
  els.stockItemForm.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => els.stockName.focus(), 250);
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
   toast("Não ? possível excluir: item tem movimentaúes ou saldo em estoque. Inative-o em vez disso.");
   return;
  }
  state.stockItems = state.stockItems.filter((entry) => entry.id !== id);
  persist();
  renderAll();
  toast("Item exclu?do.");
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
  toast("Informe uma quantidade v?lida.");
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
 toast("Entrada de material registrada. Custo m?dio recalculado.");
}

function renderStockEntryList() {
 const rows = filteredStockMovements("entrada")
  .filter((movement) => movement.type === "entrada")
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, 20);

 els.stockEntryList.innerHTML = rows.length ?
   rows.map((movement) => {
    const item = state.stockItems.find((entry) => entry.id === movement.itemId);
    return `
   <article class="report-item">
    <strong><span>${escapeHtml(item ? stockItemLabel(item) : "Item removido")}</span><span>${money(movement.totalCost)}</span></strong>
    <span class="muted">${formatDate(movement.date)} ? ${formatQuantity(movement.quantity)} ${item ? STOCK_UNIT_LABELS[item.unit] || item.unit : ""} ? ${money(movement.unitCost)}/un ? ${movement.supplierId ? personName(movement.supplierId) : "sem fornecedor"} ? ${stockUserName(movement.responsibleUserId)}</span>
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

function createProjectFromStockExitDialog() {
 const item = state.stockItems.find((entry) => entry.id === els.stockExitItem.value);
 const quantity = Number(els.stockExitQuantity.value || 0);
 const expectedCost = item ? roundCurrency(quantity * Number(item.averageCost || 0)) : 0;
 quickProjectTarget = "stockExit";
 hydrateProjectOptions();
 els.quickProjectForm.reset();
 els.quickProjectName.value = els.stockExitReason.value.trim() || (item ? `Uso de estoque - ${stockItemLabel(item)}` : "");
 els.quickProjectCustomer.value = "";
 els.quickProjectStatus.value = "ativo";
 els.quickProjectStartDate.value = els.stockExitDate.value || todayIso;
 els.quickProjectContractValue.value = 0;
 els.quickProjectExpectedCosts.value = expectedCost;
 els.quickProjectTargetMargin.value = 20;
 els.quickProjectNotes.value = "Criado a partir da saída de material do estoque.";
 els.quickProjectDialog.showModal();
 els.quickProjectName.focus();
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
  toast("Informe uma quantidade v?lida.");
  return;
 }
 if (quantity > item.quantity) {
  toast(`Estoque insuficiente: dispon?vel ${formatQuantity(item.quantity)} ${STOCK_UNIT_LABELS[item.unit] || item.unit}.`);
  return;
 }

 const exitType = els.stockExitType.value;
 const projectId = exitType === "consumo_projeto" ? els.stockExitProject.value : "";
 if (exitType === "consumo_projeto" && !projectId) {
  toast("Selecione ou cadastre o projeto de destino.");
  return;
 }
 const balanceBefore = item.quantity;
 const unitCost = item.averageCost;
 const totalCost = roundCurrency(quantity * unitCost);
 const exitDate = els.stockExitDate.value || todayIso;

 item.quantity = roundCurrency(balanceBefore - quantity);
 item.updatedAt = new Date().toISOString();

 let transactionId = "";
 if (exitType === "consumo_projeto" && projectId) {
  // status "pago" sem paidDate de prop?sito: o caixa j? saiu na compra original do material
  // (entrada de estoque). Isso faz o custo entrar no resultado do projeto (que soma todo
  // "pagar" alocado, pago ou não) sem duplicar o KPI de "Resultado do mês" da empresa
  // (que s? conta transaúes com data de pagamento no mês).
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

 persist(["estoque", "financeiro", "projetos"]);
 renderAll();
 resetStockExitForm();
 toast("Saída de material registrada.");
}

function renderStockExitList() {
 const rows = filteredStockMovements("saida")
  .filter((movement) => movement.type === "saida")
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, 20);

 els.stockExitList.innerHTML = rows.length ?
   rows.map((movement) => {
    const item = state.stockItems.find((entry) => entry.id === movement.itemId);
    return `
   <button class="report-item report-item-button" type="button" data-stock-movement-id="${movement.id}">
    <strong><span>${escapeHtml(item ? stockItemLabel(item) : "Item removido")}</span><span>${money(movement.totalCost)}</span></strong>
    <span class="muted">${formatDate(movement.date)} ? ${formatQuantity(movement.quantity)} ${item ? STOCK_UNIT_LABELS[item.unit] || item.unit : ""} ? ${STOCK_EXIT_TYPE_LABELS[movement.exitType] || movement.exitType} ? ${movement.projectId ? projectName(movement.projectId) : "Sem projeto"} ? ${stockUserName(movement.responsibleUserId)}</span>
    <small class="muted">Ver lan?amento completo</small>
   </button>`;
   }).join("")
  : emptyMessage("Nenhuma saída registrada.");

 els.stockExitList.querySelectorAll("[data-stock-movement-id]").forEach((button) => {
  button.addEventListener("click", () => openStockMovementDialog(button.dataset.stockMovementId));
 });
}

function openStockMovementDialog(id) {
 const movement = state.stockMovements.find((entry) => entry.id === id);
 if (!movement) return;
 const item = state.stockItems.find((entry) => entry.id === movement.itemId);
 const transaction = movement.transactionId ? state.transactions.find((entry) => entry.id === movement.transactionId) : null;
 const unitLabel = item ? STOCK_UNIT_LABELS[item.unit] || item.unit : "";
 els.stockMovementTitle.textContent = movement.type === "saida" ? "Detalhes da saída" : "Detalhes da movimentação";
 els.stockMovementDetails.innerHTML = [
  detailItem("Item", item ? stockItemLabel(item) : movement.itemName || "Item removido"),
  detailItem("Data", formatDate(movement.date)),
  detailItem("Tipo", STOCK_EXIT_TYPE_LABELS[movement.exitType] || movement.exitType || "Saída"),
  detailItem("Quantidade", `${formatQuantity(movement.quantity)} ${unitLabel}`.trim()),
  detailItem("Custo unit?rio", money(movement.unitCost)),
  detailItem("Valor total", money(movement.totalCost)),
  detailItem("Saldo antes", formatQuantity(movement.balanceBefore)),
  detailItem("Saldo depois", formatQuantity(movement.balanceAfter)),
  detailItem("Projeto", movement.projectId ? projectName(movement.projectId) : "Sem projeto"),
  detailItem("Funcion?rio/equipe", movement.recipientName || "Não informado"),
  detailItem("Usu?rio respons?vel", stockUserName(movement.responsibleUserId)),
  detailItem("Motivo", movement.reason || "Não informado"),
  detailItem("Conta vinculada", transaction ? `${transaction.description} ? ${money(transaction.amount)} ? ${statusLabel(transaction.status)}` : "Sem conta vinculada"),
  detailItem("Observaúes", movement.notes || "Sem observaúes", true),
 ].join("");
 els.stockMovementDialog.showModal();
}

function detailItem(label, value, full = false) {
 return `
  <article class="detail-item${full ? " full" : ""}">
   <span>${escapeHtml(label)}</span>
   <strong>${escapeHtml(String(value || "-"))}</strong>
  </article>`;
}

function renderStockAlerts() {
 const items = state.stockItems.filter((item) => item.active);
 const totalValue = sum(items.map((item) => Number(item.quantity || 0) * Number(item.averageCost || 0)));
 const monthMovements = state.stockMovements.filter((movement) => isInPeriod(movement.date, currentMonthStart, currentMonthEnd));
 const monthEntries = sum(monthMovements.filter((movement) => movement.type === "entrada").map((movement) => Number(movement.totalCost || 0)));
 const monthExits = sum(monthMovements.filter((movement) => movement.type === "saida").map((movement) => Number(movement.totalCost || 0)));
 els.stockTotalValue.textContent = money(totalValue);
 els.stockPurchaseCount.textContent = String(items.filter((item) => item.quantity < item.minQuantity).length);
 els.stockAlertBelowMin.textContent = String(items.filter((item) => item.quantity > 0 && item.quantity < item.minQuantity).length);
 els.stockAlertZero.textContent = String(items.filter((item) => item.quantity <= 0).length);
 els.stockAlertAboveMax.textContent = String(items.filter((item) => item.maxQuantity > 0 && item.quantity > item.maxQuantity).length);
 els.stockMonthEntryTotal.textContent = money(monthEntries);
 els.stockMonthExitTotal.textContent = money(monthExits);
 els.stockMonthResultTotal.textContent = money(monthEntries - monthExits);
 document.querySelectorAll("[data-stock-status-filter]").forEach((card) => {
  card.classList.toggle("active-filter", els.stockFilterStatus.value === card.dataset.stockStatusFilter);
 });
}

function filteredStockMovements(forcedType = "") {
 const start = els.stockFilterStart.value;
 const end = els.stockFilterEnd.value;
 const selectedType = els.stockFilterType.value;
 const type = forcedType || selectedType;
 if (forcedType && selectedType && selectedType !== forcedType) return [];
 const projectId = els.stockFilterProject.value;
 const itemId = els.stockFilterItem.value;
 return state.stockMovements
  .filter((movement) => !type || movement.type === type)
  .filter((movement) => !start || movement.date >= start)
  .filter((movement) => !end || movement.date <= end)
  .filter((movement) => !projectId || movement.projectId === projectId)
  .filter((movement) => !itemId || movement.itemId === itemId);
}

function clearStockFilters() {
 els.stockFilterStart.value = currentMonthStart;
 els.stockFilterEnd.value = currentMonthEnd;
 els.stockFilterType.value = "";
 els.stockFilterProject.value = "";
 els.stockFilterItem.value = "";
 els.stockFilterStatus.value = "";
 els.stockFilterCategory.value = "";
 els.stockItemSearch.value = "";
 renderStock();
}

function applyStockStatusFilter(status) {
 els.stockFilterStatus.value = status;
 setStockTab("itens");
 renderStock();
 document.querySelector(".stock-filter-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderStockPurchaseNeed() {
 const rows = state.stockItems
  .filter((item) => item.active && item.quantity < item.minQuantity)
  .map((item) => ({ item, suggestion: Math.max(0, (item.maxQuantity || item.minQuantity) - item.quantity) }))
  .sort((a, b) => b.suggestion - a.suggestion);

 els.stockPurchaseNeedTable.innerHTML = rows.length ?
   rows.map(({ item, suggestion }) => `
   <tr>
    <td>${escapeHtml(stockItemLabel(item))}</td>
    <td class="money">${formatQuantity(item.quantity)}</td>
    <td class="money">${formatQuantity(item.minQuantity)}</td>
    <td class="money">${formatQuantity(item.maxQuantity)}</td>
    <td class="money">${formatQuantity(suggestion)}</td> ?
   </tr>`).join("")
  : `<tr><td colspan="5">${emptyMessage("Nenhum item abaixo do estoque m?nimo.")}</td></tr>`;
}

function renderStock() {
 ensureIluminarStockLoaded();
 hydrateStockCatalogOptions();
 renderStockItems();
 renderStockEntryList();
 renderStockExitList();
 renderStockAlerts();
 renderStockPurchaseNeed();
}

function ensureIluminarStockLoaded() {
 if (stockAutoImportRunning) return;
 const payload = window.ILUMINAR_STOCK_IMPORT;
 if (!payload.items.length) return;
 const expectedImportedItems = payload.items.length + (payload.uncatalogedItems || []).length;
 const importedItemsCount = state.stockItems.filter((item) => item.source === payload.sourceFile || item.notes.includes("Controle Estoque Iluminar")).length;
 if (importedItemsCount >= expectedImportedItems) return;
 stockAutoImportRunning = true;
 const stockImport = importIluminarStock({ silent: true, includeMovements: false });
 stockAutoImportRunning = false;
 if (stockImport.changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---- CRM ----

function sellerName(id) {
 return state.sellers.find((seller) => seller.id === id)?.name || "Sem vendedor";
}

function opportunityLabel(opportunity) {
 return `${opportunity.title} ? ${personName(opportunity.personId)}`;
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

function setCrmView(view) {
 currentCrmView = view === "lista" ? "lista" : "kanban";
 document.querySelectorAll("[data-crm-view]").forEach((button) => {
  button.classList.toggle("active", button.dataset.crmView === currentCrmView);
 });
 document.querySelectorAll("[data-crm-view-panel]").forEach((panel) => {
  panel.classList.toggle("hidden", panel.dataset.crmViewPanel !== currentCrmView);
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
 els.sellerList.innerHTML = state.sellers.length ?
   state.sellers.map((seller) => `
   <article class="person-item">
    <strong><span>${escapeHtml(seller.name)}</span><span>${seller.active ? "Ativo" : "Inativo"}</span></strong>
    <div class="row-actions">
     <button type="button" data-seller-action="toggle" data-id="${seller.id}">${seller.active ? "Inativar" : "Ativar"}</button>
    </div> ?
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

function openOpportunityDialog(item = null) {
 els.opportunityForm.reset();
 hydrateCrmOptions();
 els.opportunityId.value = item.id || "";
 els.opportunityPerson.value = item.personId || els.opportunityPerson.value;
 els.opportunityCompany.value = item.company || "";
 els.opportunityNumber.value = item.number || item.title || nextOpportunityNumber();
 els.opportunityValue.value = item.value || 0;
 els.opportunityUnit.value = item.unitId || state.crmUnits[0].id || "";
 els.opportunityPipeline.value = item.pipelineId || els.crmPipelineFilter.value || state.crmPipelines[0].id || "";
 els.opportunityStage.value = item.stageId || state.opportunityStages[0].id || "";
 if (els.opportunityClosedDate) els.opportunityClosedDate.value = item.closedDate || (isOpportunityWon(item || {}) ? opportunityWonDate(item) : "");
 setOpportunityOwnerValue(item);
 els.opportunityPhone.value = item.phone || "";
 els.opportunityEmail.value = item.email || "";
 els.opportunityProject.value = item.projectId || "";
 els.opportunityTags.value = normalizeTags(item.tags).join(", ");
 els.opportunityNextActivity.value = item.nextActivityDate || "";
 els.opportunityPendingActivity.checked = Boolean(item.pendingActivity);
 els.opportunityNotes.value = item.notes || "";
 els.opportunityAddress.value = item.location.address || "";
 els.opportunityLatitude.value = item.location.latitude || "";
 els.opportunityLongitude.value = item.location.longitude || "";
 els.opportunityDriveFolder.value = item.driveFolderUrl || "";
 opportunityAttachmentsDraft = normalizeOpportunityAttachments(item.attachments);
 renderOpportunityAttachmentRows();
 setOpportunityAttachmentStatus("Arraste links ou arquivos para anexar ao lead. Salve a oportunidade ao concluir.", "neutral");
 setOpportunityProposalForm(item.proposal || {});
 els.opportunityTitle.textContent = item ? "Editar oportunidade" : "Nova oportunidade";
 renderOpportunityHistory(item.id || "");
 els.opportunityDialog.showModal();
}

function saveOpportunity() {
 const now = new Date().toISOString();
 const id = els.opportunityId.value || crypto.randomUUID();
 const existing = state.opportunities.find((item) => item.id === id);
 const ownerData = readOpportunityOwnerFromForm();
 const stageId = els.opportunityStage.value;
 const pipelineStage = stageId === "ganho" ? "ganho"
  : stageId === "perdido" ? "perdido"
   : stageId === "proposta" ? "proposta"
    : stageId === "negociacao" ? "negociacao"
     : "prospeccao";
 const closedDate = els.opportunityClosedDate.value || existing.closedDate || "";
 const data = {
  ...(existing || {}),
  id,
  personId: els.opportunityPerson.value,
  title: existing.title || els.opportunityNumber.value.trim() || nextOpportunityNumber(),
  company: els.opportunityCompany.value.trim(),
  number: els.opportunityNumber.value.trim() || existing.number || nextOpportunityNumber(),
  value: Number(els.opportunityValue.value || 0),
  unitId: els.opportunityUnit.value,
  pipelineId: els.opportunityPipeline.value,
  stageId,
  stage: pipelineStage,
  closedDate: pipelineStage === "ganho" ? closedDate : "",
  wonAt: pipelineStage === "ganho" && closedDate ? new Date(`${closedDate}T12:00:00`).toISOString() : existing.wonAt || "",
  owner: ownerData.owner,
  ownerUserId: ownerData.ownerUserId,
  phone: els.opportunityPhone.value.trim(),
  email: els.opportunityEmail.value.trim(),
  projectId: els.opportunityProject.value,
  tags: normalizeTags(els.opportunityTags.value),
  pendingActivity: els.opportunityPendingActivity.checked,
  nextActivityDate: els.opportunityNextActivity.value,
  notes: els.opportunityNotes.value.trim(),
  location: {
   address: els.opportunityAddress.value.trim(),
   latitude: els.opportunityLatitude.value.trim(),
   longitude: els.opportunityLongitude.value.trim(),
  },
  driveFolderUrl: els.opportunityDriveFolder.value.trim(),
  attachments: readOpportunityAttachmentsFromForm(),
  proposal: readOpportunityProposalFromForm(),
  createdAt: existing.createdAt || now,
  updatedAt: now,
  lastMovedAt: existing.lastMovedAt || now,
  lastContactAt: existing.lastContactAt || "",
  stageChangedAt: existing.stageId === stageId ? existing.stageChangedAt || now : now,
  stageHistory: existing.stageHistory.length ? [...existing.stageHistory] : [{ stage: pipelineStage, at: now }],
 };
 if (existing && existing.stageId !== data.stageId) {
  addOpportunityHistory(id, "mudanca de etapa", existing.stageId, data.stageId);
  data.lastMovedAt = now;
  data.stageHistory.push({ stage: pipelineStage, at: now });
 }

 const index = state.opportunities.findIndex((item) => item.id === id);
 if (index >= 0) {
  state.opportunities[index] = data;
 } else {
  state.opportunities.push(data);
  addOpportunityHistory(id, "criacao", "", data.stageId);
 }

 persist("crm");
 renderAll();
 els.opportunityDialog.close();
 toast("Oportunidade salva.");
 if (data.stage === "ganho" && (!existing || existing.stage !== "ganho") && !data.installationId && !data.contractId) {
  openOpportunityWonDialog(data);
 }
}

function renderPipelineBoard() {
 renderCrmKanbanMetrics();
 const visibleOpportunities = filteredOpportunities();
 const lostItems = visibleOpportunities.filter((item) => item.stage === "perdido");
 if (els.toggleLostOpportunitiesBtn) {
  els.toggleLostOpportunitiesBtn.textContent = showLostOpportunities ? `? Ocultar perdidos (${lostItems.length})`
   : `? Ver perdidos (${lostItems.length})`;
 }
 const visibleStages = OPPORTUNITY_STAGES;
 els.pipelineBoard.innerHTML = visibleStages.map((stageInfo) => {
  if (stageInfo.key === "perdido" && !showLostOpportunities) {
   const totalLost = sum(lostItems.map((item) => item.value));
   return `
   <section class="pipeline-column pipeline-column-collapsed pipeline-column-lost" data-stage="${stageInfo.key}">
    <button class="pipeline-column-toggle" type="button" data-toggle-lost-column>
     <strong>Venda perdida</strong>
     <span>${lostItems.length} lead${lostItems.length === 1 ? "" : "s"} - ${money(totalLost)}</span>
     <em>? Abrir perdidos</em>
    </button>
   </section>`;
  }
  const items = visibleOpportunities
   .filter((item) => item.stage === stageInfo.key)
   .sort((a, b) => (b.stageChangedAt || "").localeCompare(a.stageChangedAt || ""));
  const total = sum(items.map((item) => item.value));
  const overdue = items.filter(hasOverdueOpportunityTask).length;
  return `
   <section class="pipeline-column" data-stage="${stageInfo.key}">
    <div class="pipeline-column-head">
     <strong>${stageInfo.label}</strong>
     <span>${items.length} lead${items.length === 1 ? "" : "s"} - ${money(total)}</span>
     ${stageInfo.key === "perdido" ? `<button class="pipeline-head-toggle" type="button" data-toggle-lost-column>?</button>` : ""}
    </div>
    ${overdue ? `<div class="pipeline-column-alert">${overdue} tarefa${overdue === 1 ? "" : "s"} vencida${overdue === 1 ? "" : "s"}</div>` : ""}
    <div class="pipeline-card-list">
     ${items.map(pipelineCard).join("") || `<div class="pipeline-empty">Sem oportunidades</div>`}
    </div>
   </section>`;
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
 document.querySelectorAll("[data-toggle-lost-column]").forEach((button) => {
  button.addEventListener("click", () => {
   showLostOpportunities = !showLostOpportunities;
   renderPipelineBoard();
  });
 });
 renderCrmLeadList();
 setCrmView(currentCrmView);
}

function crmPipelineRows() {
 return filteredOpportunities()
  .filter((item) => showLostOpportunities || item.stage !== "perdido")
  .sort((a, b) => (b.stageChangedAt || b.updatedAt || "").localeCompare(a.stageChangedAt || a.updatedAt || ""));
}

function crmStageLabel(stageKey) {
 return OPPORTUNITY_STAGES.find((stage) => stage.key === stageKey).label || stageKey || "-";
}

function renderCrmLeadList() {
 if (!els.crmLeadListTable) return;
 const rows = crmPipelineRows();
 if (els.crmLeadListSummary) {
  els.crmLeadListSummary.textContent = `${rows.length} lead(s) ${showLostOpportunities ? "incluindo perdidos" : "sem perdidos"}`;
 }
 els.crmLeadListTable.innerHTML = rows.length ? rows.map((item) => {
  const client = state.people.find((person) => person.id === item.personId);
  const phone = item.phone || client.contact || "";
  const email = item.email || "";
  return `
   <tr>
    <td><strong>${escapeHtml(personName(item.personId))}</strong><small>${escapeHtml(item.title || item.number || "")}</small></td>
    <td>${escapeHtml(phone || "-")}</td>
    <td>${escapeHtml(email || "-")}</td>
    <td>${escapeHtml(item.company || "-")}</td>
    <td><span class="status ${item.stage === "ganho" ? "baixado" : item.stage === "perdido" ? "vencido" : "aberto"}">${escapeHtml(crmStageLabel(item.stage))}</span></td>
    <td class="money">${money(item.value)}</td>
    <td>${escapeHtml(opportunityOwnerDisplay(item))}</td>
    <td>${escapeHtml(item.projectId ? projectName(item.projectId) : "Sem projeto")}</td>
    <td>${formatDate((item.stageChangedAt || item.updatedAt || item.createdAt || "").slice(0, 10))}</td>
    <td class="row-actions"><button type="button" data-crm-list-edit="${item.id}">Editar</button></td>
   </tr>`;
 }).join("") : `<tr><td colspan="10">${emptyMessage("Nenhum lead encontrado.")}</td></tr>`;

 document.querySelectorAll("[data-crm-list-edit]").forEach((button) => {
  button.addEventListener("click", () => {
   const opportunity = state.opportunities.find((item) => item.id === button.dataset.crmListEdit);
   if (opportunity) openOpportunityDialog(opportunity);
  });
 });
}

function renderCrmKanbanMetrics() {
 if (!els.crmKanbanMetrics) return;
 const visibleOpportunities = opportunitiesVisibleToCurrentUser();
 const active = visibleOpportunities.filter((item) => !["ganho", "perdido"].includes(item.stage));
 const dueToday = active.filter((item) => item.expectedCloseDate === todayIso).length;
 const withoutTask = active.filter((item) => !item.expectedCloseDate).length;
 const overdue = active.filter(hasOverdueOpportunityTask).length;
 const createdRecently = visibleOpportunities.filter((item) => {
  const created = (item.createdAt || "").slice(0, 10);
  return created === todayIso || created === toIso(addDays(today, -1));
 }).length;
 const prospective = visibleOpportunities.filter((item) => item.stage === "prospeccao").length;
 els.crmKanbanMetrics.innerHTML = [
  { label: "Tarefas para hoje", value: dueToday, tone: "ok" },
  { label: "Sem tarefa agendada", value: withoutTask, tone: "warn" },
  { label: "Tarefas vencidas", value: overdue, tone: "danger" },
  { label: "Novos hoje/ontem", value: createdRecently, tone: "neutral" },
  { label: "Prospeccao", value: prospective || "Sem dados", tone: "neutral" },
 ].map((item) => `
  <article class="crm-kanban-metric ${item.tone}">
   <span>${item.label}</span>
   <strong>${item.value}</strong>
  </article>
 `).join("");
}

function hasOverdueOpportunityTask(opportunity) {
 return Boolean(opportunity.expectedCloseDate && opportunity.expectedCloseDate < todayIso && !["ganho", "perdido"].includes(opportunity.stage));
}

function pipelineCard(opportunity) {
 const daysStalled = daysSince(opportunity.stageChangedAt);
 const stalled = daysStalled >= 14 && !["ganho", "perdido"].includes(opportunity.stage);
 const dueText = opportunity.expectedCloseDate ? formatDate(opportunity.expectedCloseDate) : "Sem data";
 const projectText = opportunity.projectId ? projectName(opportunity.projectId) : "";
 const overdue = hasOverdueOpportunityTask(opportunity);
 return `
  <article class="pipeline-card ${stalled ? "stalled" : ""}">
   <button class="pipeline-card-title" type="button" data-opportunity-edit="${opportunity.id}">
    <span>${escapeHtml(personName(opportunity.personId))}</span>
    <small>${escapeHtml(dueText)}</small>
   </button>
   <strong>${escapeHtml(opportunity.title)}</strong>
   <div class="pipeline-card-value">
    <span>${money(opportunity.value)}</span>
    <small>${escapeHtml(opportunityOwnerDisplay(opportunity))}</small>
   </div>
   <div class="pipeline-card-tags">
    ${projectText ? `<span>${escapeHtml(projectText)}</span>` : ""}
    ${stalled ? `<span class="warn">+${daysStalled} dias</span>` : ""}
    ${overdue ? `<span class="danger">vencida</span>` : ""}
   </div>
   <select aria-label="Alterar etapa" data-opportunity-stage-select="${opportunity.id}">
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

function syncOpportunityWonProjectChoice() {
 if (!els.opportunityWonCreateProject || !els.opportunityWonServiceType) return;
 els.opportunityWonCreateProject.checked = installationRequiresProject(els.opportunityWonServiceType.value);
}

function opportunityWonSettingsFromDialog() {
 const serviceType = els.opportunityWonServiceType.value || "instalacao_projeto";
 return {
  closedDate: els.opportunityWonClosedDate.value || todayIso,
  serviceType,
  createProject: Boolean(els.opportunityWonCreateProject.checked) && installationRequiresProject(serviceType),
 };
}

function applyOpportunityWonSettings(opportunity, settings = {}) {
 const closedDate = settings.closedDate || todayIso;
 opportunity.closedDate = closedDate;
 opportunity.serviceType = settings.serviceType || opportunity.serviceType || "instalacao_projeto";
 opportunity.postSaleDueDate = addBusinessDaysIso(closedDate, 2);
 opportunity.wonAt = new Date(`${closedDate}T12:00:00`).toISOString();
 opportunity.updatedAt = new Date().toISOString();
 persist("crm");
}

function ensureProjectFromWonOpportunity(opportunity, settings = {}) {
 if (opportunity.projectId && state.projects.some((project) => project.id === opportunity.projectId)) return opportunity.projectId;
 const now = new Date().toISOString();
 const closedDate = settings.closedDate || opportunity.closedDate || todayIso;
 const projectId = crypto.randomUUID();
 const project = {
  id: projectId,
  code: "",
  name: opportunity.title || `Projeto ${personName(opportunity.personId)}`,
  customerId: opportunity.personId,
  status: "homologacao",
  startDate: closedDate,
  endDate: "",
  contractValue: Number(opportunity.value || 0),
  expectedCosts: 0,
  targetMargin: 20,
  costCenterId: crypto.randomUUID(),
  notes: `Criado automaticamente a partir de oportunidade ganha no CRM. P\u00f3s-venda at\u00e9 ${formatDate(addBusinessDaysIso(closedDate, 2))}.`,
  createdAt: now,
  updatedAt: now,
 };
 state.projects.push(project);
 upsertCostCenter(project);
 opportunity.projectId = projectId;
 return projectId;
}

function createInstallationFromWonOpportunity(opportunity, settings = {}) {
 const now = new Date().toISOString();
 const serviceType = settings.serviceType || opportunity.serviceType || "instalacao_projeto";
 const closedDate = settings.closedDate || opportunity.closedDate || todayIso;
 const postSaleDueDate = addBusinessDaysIso(closedDate, 2);
 const deadlineDate = addBusinessDaysIso(closedDate, 15);
 const projectId = settings.createProject ? ensureProjectFromWonOpportunity(opportunity, settings) : (opportunity.projectId || "");
 const existing = state.installations.find((item) => item.opportunityId === opportunity.id);
 const installation = {
  ...(existing || {}),
  id: existing.id || crypto.randomUUID(),
  projectId,
  customerId: opportunity.personId,
  serviceType,
  status: existing.status || (projectId && installationRequiresProject(serviceType) ? "aguardando_projeto" : "sem_programacao"),
  closedDate,
  postSaleDueDate,
  postSaleContactedAt: existing.postSaleContactedAt || "",
  deadlineDate,
  scheduledDate: existing.scheduledDate || "",
  completedDate: existing.completedDate || "",
  panels: existing.panels || Number(opportunity.proposal.moduleQuantity || 0),
  team: existing.team || "",
  labor: existing.labor || [],
  technicalReport: existing.technicalReport || {
   warrantyStartDate: "",
   technician: "",
   whatsapp: "",
   email: "",
   summary: "",
   photos: [],
   generatedAt: "",
  },
  materials: existing.materials || "",
  notes: [
   existing.notes || "",
   `Gerado pelo CRM em ${formatDate(todayIso)}. Fechamento em ${formatDate(closedDate)}. Contato p\u00f3s-venda at\u00e9 ${formatDate(postSaleDueDate)}.`,
   opportunity.driveFolderUrl ? `Pasta/anexos do lead: ${opportunity.driveFolderUrl}` : "",
  ].filter(Boolean).join("\n"),
  conclusion: existing.conclusion || "",
  opportunityId: opportunity.id,
  contractId: opportunity.contractId || "",
  createdAt: existing.createdAt || now,
  updatedAt: now,
 };
 if (existing) {
  const index = state.installations.findIndex((item) => item.id === existing.id);
  state.installations[index] = installation;
 } else {
  state.installations.push(installation);
 }
 opportunity.installationId = installation.id;
 opportunity.updatedAt = now;
 persist(["crm", "projetos"]);
 renderAll();
 setView("instalacoes");
 toast("Ganho enviado para Instala\u00e7\u00f5es com prazo de p\u00f3s-venda.");
}

function openOpportunityWonDialog(opportunity) {
 pendingWonOpportunity = opportunity;
 els.opportunityWonSummary.textContent = `${opportunity.title} ? ${personName(opportunity.personId)} ? ${money(opportunity.value)}`;
 if (els.opportunityWonClosedDate) els.opportunityWonClosedDate.value = opportunity.closedDate || (opportunity.wonAt || "").slice(0, 10) || todayIso;
 if (els.opportunityWonServiceType) els.opportunityWonServiceType.value = opportunity.serviceType || "instalacao_projeto";
 syncOpportunityWonProjectChoice();
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
 toast("Revise os dados do projeto e clique em Salvar projeto para concluir a convers?o.");
}

function generateContractFromOpportunity(opportunity, settings = {}) {
 if (opportunity.contractId) {
  toast("Essa oportunidade j? possui contrato gerado.");
  setView("homologacao");
  return;
 }

 const now = new Date().toISOString();
 const contractId = crypto.randomUUID();
 const projectId = crypto.randomUUID();
 const installationId = crypto.randomUUID();
 const saleId = crypto.randomUUID();
 const closedDate = settings.closedDate || opportunity.closedDate || todayIso;
 const serviceType = settings.serviceType || opportunity.serviceType || "instalacao_projeto";
 const dueDate = opportunity.expectedCloseDate || todayIso;
 const title = opportunity.title || `Contrato ${personName(opportunity.personId)}`;
 const amount = Number(opportunity.value || 0);

 const project = {
  id: projectId,
  code: "",
  name: title,
  customerId: opportunity.personId,
  status: "homologacao",
  startDate: closedDate,
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
  saleDate: closedDate,
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
  serviceType,
  status: "aguardando_projeto",
  closedDate,
  postSaleDueDate: addBusinessDaysIso(closedDate, 2),
  postSaleContactedAt: "",
  deadlineDate: addBusinessDaysIso(closedDate, 15),
  scheduledDate: dueDate,
  completedDate: "",
  panels: 0,
  team: "",
  labor: [],
  technicalReport: {
   warrantyStartDate: "",
   technician: "",
   whatsapp: "",
   email: "",
   summary: "",
   photos: [],
   generatedAt: "",
  },
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
 opportunity.closedDate = closedDate;
 opportunity.serviceType = serviceType;
 opportunity.postSaleDueDate = addBusinessDaysIso(closedDate, 2);
 opportunity.updatedAt = now;

 persist(["crm", "financeiro", "projetos"]);
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
 const activeOpportunities = opportunitiesVisibleToCurrentUser().filter((item) => !["ganho", "perdido"].includes(item.stage));
 const rows = activeOpportunities
  .map((opportunity) => ({ opportunity, lastInteraction: latestInteractionFor(opportunity.id) }))
  .map((row) => ({ ...row, nextFollowUp: row.lastInteraction.nextFollowUpDate || "" }))
  .sort((a, b) => (a.nextFollowUp || "9999-99-99").localeCompare(b.nextFollowUp || "9999-99-99"));

 els.followUpList.innerHTML = rows.length ?
   rows.map(({ opportunity, lastInteraction, nextFollowUp }) => {
    const overdue = nextFollowUp && nextFollowUp < todayIso;
    const lastContactText = lastInteraction ? ` ? Ãšltimo contato: ${INTERACTION_TYPE_LABELS[lastInteraction.type] || lastInteraction.type} em ${formatDate(lastInteraction.date)}` : "";
    return `
   <article class="report-item ${overdue ? "follow-up-overdue" : ""}">
    <strong><span>${escapeHtml(opportunity.title)} ? ${escapeHtml(personName(opportunity.personId))}</span><span>${money(opportunity.value)}</span></strong>
    <span class="muted">${nextFollowUp ? `Pr?ximo follow-up: ${formatDate(nextFollowUp)}` : "Sem follow-up agendado"} ? ${escapeHtml(sellerName(opportunity.sellerId))}${lastContactText}</span>
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
 document.querySelector("#interactionDialogTitle").textContent = opportunity ? `Registrar contato ? ${opportunity.title}` : "Registrar contato";
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
 const activeOpportunities = opportunitiesVisibleToCurrentUser().filter((item) => !["ganho", "perdido"].includes(item.stage));
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
  status: existing.status || "pendente",
  opportunityId: els.taskOpportunity.value,
  personId: els.taskPerson.value,
  sellerId: els.taskSeller.value,
  createdAt: existing.createdAt || new Date().toISOString(),
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
 if (!isAdmin()) {
  tasks = tasks.filter((task) => {
   if (!task.opportunityId) return true;
   const opportunity = state.opportunities.find((item) => item.id === task.opportunityId);
   return opportunity ? canViewOpportunity(opportunity) : false;
  });
 }
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
 renderTaskGroup(els.tasksWeekList, dueWeek, "Nenhuma tarefa nos pr?ximos 7 dias.");
 renderTaskGroup(els.tasksLaterList, dueLater, "Nenhuma tarefa futura.");
}

function renderTaskGroup(container, tasks, emptyText) {
 container.innerHTML = tasks.length ?
   tasks
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
    .map((task) => `
   <article class="report-item">
    <strong><span>${escapeHtml(task.title)}</span><span>${taskStatusLabel(taskComputedStatus(task))}</span></strong>
    <span class="muted">${formatDate(task.dueDate)} ? ${escapeHtml(sellerName(task.sellerId))}${task.description ? ` ? ${escapeHtml(task.description)}` : ""}</span>
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
 if (mode === "ano") {
  return { start: `${today.getFullYear()}-01-01`, end: `${today.getFullYear()}-12-31` };
 }
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

function isOpportunityWon(item) {
 return item.stage === "ganho" || item.stageId === "ganho";
}

function isOpportunityLost(item) {
 return item.stage === "perdido" || item.stageId === "perdido";
}

function opportunityWonDate(item) {
 return (item.closedDate || item.wonAt || item.stageChangedAt || item.lastMovedAt || item.updatedAt || item.createdAt || "").slice(0, 10);
}

function opportunityLostDate(item) {
 return (item.lostAt || item.stageChangedAt || item.lastMovedAt || item.updatedAt || item.createdAt || "").slice(0, 10);
}

function opportunitySellerKey(item) {
 if (item.ownerUserId) return `user:${item.ownerUserId}`;
 if (item.sellerId) return `seller:${item.sellerId}`;
 return `owner:${item.owner || "Sem respons\u00e1vel"}`;
}

function opportunitySellerLabel(key) {
 if (key.startsWith("user:")) return userName(key.replace("user:", ""));
 if (key.startsWith("seller:")) return sellerName(key.replace("seller:", ""));
 return key.replace("owner:", "") || "Sem respons?vel";
}

function getSalesRankingPeriod(mode = "month") {
 if (mode === "year" || mode === "ano") {
  return { label: `Ano ${today.getFullYear()}`, start: `${today.getFullYear()}-01-01`, end: `${today.getFullYear()}-12-31` };
 }
 return { label: today.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }), start: currentMonthStart, end: currentMonthEnd };
}

function renderCrmReports() {
 const period = getCrmReportPeriod();
 const reportOpportunities = opportunitiesVisibleToCurrentUser();
 const won = reportOpportunities.filter((item) => isOpportunityWon(item) && isInPeriod(opportunityWonDate(item), period.start, period.end));
 const lost = reportOpportunities.filter((item) => isOpportunityLost(item) && isInPeriod(opportunityLostDate(item), period.start, period.end));

 const avgTicket = won.length ? sum(won.map((item) => item.value)) / won.length : 0;
 const avgCloseDays = won.length ?
   won.reduce((total, item) => total + Math.max(0, daysBetween(opportunityWonDate(item), (item.createdAt || "").slice(0, 10))), 0) / won.length
  : 0;

 els.crmAvgTicket.textContent = money(avgTicket);
 els.crmAvgCloseTime.textContent = `${avgCloseDays.toFixed(1)} dias`;
 els.crmWonCount.textContent = String(won.length);
 els.crmLostCount.textContent = String(lost.length);

 renderStageConversionReport(reportOpportunities);
 renderSellerRanking(won, lost);
}

function renderStageConversionReport(opportunities = opportunitiesVisibleToCurrentUser()) {
 const rows = OPPORTUNITY_STAGES.filter((stageInfo) => !["ganho", "perdido"].includes(stageInfo.key)).map((stageInfo) => {
  const stageIndex = OPPORTUNITY_STAGES.findIndex((entry) => entry.key === stageInfo.key);
  const reached = opportunities.filter((item) => (item.stageHistory || []).some((entry) => entry.stage === stageInfo.key));
  const advanced = reached.filter((item) =>
   (item.stageHistory || []).some((entry) => OPPORTUNITY_STAGES.findIndex((s) => s.key === entry.stage) > stageIndex)
  );
  const rate = reached.length ? (advanced.length / reached.length) * 100 : 0;
  return { stageInfo, reachedCount: reached.length, advancedCount: advanced.length, rate };
 });

 els.crmStageConversionReport.innerHTML = rows.map((row) => `
  <article class="report-item">
   <strong><span>${row.stageInfo.label}</span><span>${row.rate.toFixed(1)}%</span></strong>
   <span class="muted">${row.advancedCount} de ${row.reachedCount} avan?aram para o pr?ximo est?gio</span>
  </article>`).join("");
}

function renderSellerRanking(won, lost) {
 const rows = buildSalesRankingRows(won, lost);

 els.crmSellerRankingTable.innerHTML = rows.length ?
   rows.map((row, index) => `
   <tr class="${index < 3 ? `ranking-row ranking-${index + 1}` : ""}">
    <td>${index < 3 ? `${index + 1} ` : ""}${escapeHtml(row.name)}</td>
    <td class="money">${money(row.total)}</td>
    <td>${row.count}</td>
    <td>${row.conversion.toFixed(1)}%</td> ?
   </tr>`).join("")
  : `<tr><td colspan="4">${emptyMessage("Sem negcios fechados no perodo.")}</td></tr>`;
}

function buildSalesRankingRows(won, lost) {
 const sellerKeys = new Set([...won.map(opportunitySellerKey), ...lost.map(opportunitySellerKey)].filter(Boolean));
 return [...sellerKeys]
  .map((key) => {
   const wonBySeller = won.filter((item) => opportunitySellerKey(item) === key);
   const lostBySeller = lost.filter((item) => opportunitySellerKey(item) === key);
   const total = sum(wonBySeller.map((item) => item.value));
   const conversion = wonBySeller.length + lostBySeller.length ? (wonBySeller.length / (wonBySeller.length + lostBySeller.length)) * 100 : 0;
   return { key, name: opportunitySellerLabel(key), total, count: wonBySeller.length, conversion };
  })
  .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
}

function salesRankingRowsForPeriod(mode) {
 const period = getSalesRankingPeriod(mode);
 const rankingOpportunities = opportunitiesVisibleToCurrentUser();
 const won = rankingOpportunities.filter((item) => isOpportunityWon(item) && isInPeriod(opportunityWonDate(item), period.start, period.end));
 const lost = rankingOpportunities.filter((item) => isOpportunityLost(item) && isInPeriod(opportunityLostDate(item), period.start, period.end));
 return { period, rows: buildSalesRankingRows(won, lost), won, lost };
}

function salesRankingTvUrl(mode) {
 const url = new URL(window.location.href);
 url.search = "";
 url.searchParams.set("tv", "ranking");
 url.searchParams.set("period", mode);
 return url.toString();
}

function openSalesRankingTv(mode) {
 window.open(salesRankingTvUrl(mode), "_blank");
}

function isSalesRankingTvMode() {
 const params = new URLSearchParams(window.location.search);
 return params.get("tv") === "ranking";
}

function renderSalesRankingTvMode() {
 const params = new URLSearchParams(window.location.search);
 const mode = params.get("period") === "year" ? "year" : "month";
 const { period, rows, won } = salesRankingRowsForPeriod(mode);
 document.title = `Ranking de vendas - ${period.label}`;
 els.loginScreen.classList.add("hidden");
 els.appShell.classList.add("hidden");
 hideMaintenance();

 let screen = document.querySelector("#salesRankingTvScreen");
 if (!screen) {
  screen = document.createElement("main");
  screen.id = "salesRankingTvScreen";
  screen.className = "ranking-tv-screen";
  document.body.appendChild(screen);
 }

 const podium = [rows[1], rows[0], rows[2]];
 screen.innerHTML = `
  <section class="ranking-tv-hero">
   <div>
    <span>Lumeris Engenharia</span>
    <h1>Ranking de vendas</h1>
    <p>${escapeHtml(period.label)} - ${won.length} negócio${won.length === 1 ? "" : "s"} fechado${won.length === 1 ? "" : "s"}</p>
   </div>
   <div class="ranking-tv-clock">${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
  </section>
  <section class="ranking-podium">
   ${podium.map((row, index) => {
    const place = index === 1 ? 1 : index === 0 ? 2 : 3;
    const heightClass = place === 1 ? "first" : place === 2 ? "second" : "third";
    return row ? `
     <article class="podium-card ${heightClass}">
      <div class="medal">${place}</div>
      <h2>${escapeHtml(row.name)}</h2>
      <strong>${money(row.total)}</strong>
      <span>${row.count} venda${row.count === 1 ? "" : "s"} - ${row.conversion.toFixed(1)}% conversão</span>
     </article>` : `
     <article class="podium-card empty ${heightClass}">
      <div class="medal">${place}</div>
      <h2>Sem vendedor</h2>
      <strong>${money(0)}</strong>
      <span>Aguardando venda fechada</span>
     </article>`;
   }).join("")}
  </section>
  <section class="ranking-tv-list">
   ${rows.slice(3, 10).map((row, index) => `
    <article>
     <span>${index + 4}</span>
     <strong>${escapeHtml(row.name)}</strong>
     <em>${money(row.total)}</em>
     <small>${row.count} venda${row.count === 1 ? "" : "s"}</small>
    </article>
   `).join("") || `<article><strong>Sem outros vendedores no ranking</strong><em>${money(0)}</em></article>`}
  </section>
 `;
}

function renderCrm() {
 hydrateSellerOptions();
 renderVisibleCrmKanban();
 renderPipelineBoard();
 renderFollowUpList();
 renderTasks();
 renderCrmReports();
}

function renderVisibleCrmKanban() {
 if (!els.kanbanBoard) return;
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
 els.invoiceXmlFile.value = "";
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
 els.invoicePerson.innerHTML = people.length ?
   people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
  : `<option value="">Cadastre ${wantType === "cliente" ? "um cliente" : "um fornecedor"} primeiro</option>`;
}

async function importInvoiceXml(event) {
 const file = event.target.files?.[0];
 if (!file) return;

 try {
  const xmlText = await file.text();
  const data = parseInvoiceXml(xmlText);
  if (!data.number && !data.grossAmount) {
   toast("Não consegui identificar os dados principais desse XML.");
   return;
  }

  els.invoiceNumber.value = data.number || els.invoiceNumber.value;
  els.invoiceSeries.value = data.series || els.invoiceSeries.value;
  els.invoiceDocument.value = data.document || els.invoiceDocument.value;
  els.invoiceIssueDate.value = data.issueDate || els.invoiceIssueDate.value || todayIso;
  els.invoiceDueDate.value = data.dueDate || els.invoiceDueDate.value;
  els.invoiceCategory.value = data.category || els.invoiceCategory.value;
  els.invoiceGrossAmount.value = data.grossAmount || els.invoiceGrossAmount.value;
  els.invoiceTaxAmount.value = data.taxAmount || 0;
  els.invoiceAccountingValue.value = data.accountingValue || data.grossAmount || els.invoiceAccountingValue.value;
  els.invoiceDescription.value = data.description || els.invoiceDescription.value;
  els.invoiceProject.value = "";

  const personId = upsertPersonFromInvoiceXml(data);
  if (personId) {
   hydrateInvoicePersonOptions();
   els.invoicePerson.value = personId;
  }

  if (els.invoiceKind.value === "despesa") els.invoiceStatus.value = "aberto";
  els.invoiceNotes.value = [els.invoiceNotes.value.trim(), "Importada por XML. Projeto pendente de conciliação."].filter(Boolean).join("\n");
  suggestInvoiceAccountingValue();
  toast("XML importado. Revise os dados e vincule o projeto quando necess?rio.");
 } catch (error) {
  console.error(error);
  toast("Não foi possível ler o XML da NF.");
 } finally {
  event.target.value = "";
 }
}

function parseInvoiceXml(xmlText) {
 const doc = new DOMParser().parseFromString(xmlText, "application/xml");
 if (doc.querySelector("parsererror")) throw new Error("XML inv?lido");
 const tag = (...names) => {
  for (const name of names) {
   const node = [...doc.getElementsByTagName(name)][0];
   const value = node.textContent.trim();
   if (value) return value;
  }
  return "";
 };
 const emit = doc.getElementsByTagName("emit")[0] || doc;
 const emitTag = (...names) => {
  for (const name of names) {
   const node = emit.getElementsByTagName(name)[0];
   const value = node.textContent.trim();
   if (value) return value;
  }
  return "";
 };
 const serviceValue = tag("ValorServicos", "ValorServico");
 const productTotal = tag("vNF", "ValorNfse", "ValorNota");
 const taxValue = tag("ValorDeducoes", "vTotTrib", "ValorIss", "ValorIssRetido");
 const issueRaw = tag("dhEmi", "dEmi", "DataEmissao", "Competencia");
 const description = tag("Discriminacao", "xProd", "infCpl", "xNome");
 return {
  number: tag("nNF", "Numero", "NumeroNfse", "NumeroNota"),
  series: tag("serie", "Serie", "SerieNfse"),
  document: onlyDigits(emitTag("CNPJ", "CPF", "CpfCnpj")),
  personName: emitTag("xNome", "RazaoSocial", "Nome"),
  issueDate: xmlDateToIso(issueRaw),
  dueDate: xmlDateToIso(tag("dVenc", "DataVencimento")),
  category: serviceValue ? "Serviços" : "Nota fiscal",
  grossAmount: parseXmlMoney(productTotal || serviceValue),
  taxAmount: parseXmlMoney(taxValue),
  accountingValue: parseXmlMoney(productTotal || serviceValue),
  description,
 };
}

function upsertPersonFromInvoiceXml(data) {
 if (!data.personName && !data.document) return "";
 const meta = INVOICE_KIND_META[els.invoiceKind.value] || INVOICE_KIND_META.servico;
 const type = meta.direction === "recebida" ? "fornecedor" : "cliente";
 const document = onlyDigits(data.document);
 const personNameFromXml = data.personName || "";
 const existing = state.people.find((person) => (document && onlyDigits(person.document) === document) || (personNameFromXml && person.name.toLowerCase() === personNameFromXml.toLowerCase()));
 if (existing) return existing.id;
 const person = {
  id: crypto.randomUUID(),
  type,
  name: data.personName || `Cadastro XML ${document}`,
  document,
  contact: "",
 };
 state.people.push(person);
 persist();
 renderPeople();
 return person.id;
}

function onlyDigits(value) {
 return String(value || "").replace(/\D/g, "");
}

function xmlDateToIso(value) {
 if (!value) return "";
 const text = String(value).trim();
 const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
 if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
 const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
 if (br) return `${br[3]}-${br[2]}-${br[1]}`;
 return "";
}

function parseXmlMoney(value) {
 if (!value) return 0;
 const raw = String(value).trim();
 const text = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
 const parsed = Number(text);
 return Number.isFinite(parsed) ? roundCurrency(parsed) : 0;
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
 return meta.statusOptions.find((option) => option.value === invoice.status).label || invoice.status;
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
  toast("J? existe uma NF com esse n?mero para esse cliente/fornecedor.");
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
  createdAt: existing.createdAt || new Date().toISOString(),
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

 els.invoiceList.innerHTML = invoices.length ?
   invoices.map(invoiceRow).join("")
  : emptyMessage("Nenhuma nota fiscal cadastrada.");

 document.querySelectorAll("[data-invoice-action]").forEach((button) => {
  button.addEventListener("click", () => handleInvoiceAction(button.dataset.invoiceAction, button.dataset.id));
 });
}

function invoiceRow(invoice) {
 const linked = linkedTransactionsForInvoice(invoice.id);
 const linkText = linked.length ? `${linked.length} parcela(s) vinculada(s) (${money(sum(linked))})` : "sem vínculo financeiro";
 const projectText = invoice.projectId ? `Projeto: ${projectName(invoice.projectId)}` : "Projeto pendente";
 return `
  <article class="person-item">
   <strong><span>NF ${escapeHtml(invoice.number)}${invoice.series ? "/" + escapeHtml(invoice.series) : ""} ? ${escapeHtml(personName(invoice.personId))}</span><span>${money(invoice.accountingValue)}</span></strong>
   <span class="muted">${formatDate(invoice.issueDate)} - ${invoiceStatusLabel(invoice)} - ${linkText} - ${escapeHtml(projectText)}</span>
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
   toast("Desvincule os lan?amentos financeiros antes de excluir esta NF.");
   return;
  }
  state.bankMovements.filter((item) => item.invoiceId === invoice.id).forEach((item) => {
   item.invoiceId = "";
  });
  state.invoices = state.invoices.filter((item) => item.id !== invoice.id);
  persist();
  renderAll();
  toast("Nota fiscal exclu?da.");
 }
}

function openInvoiceLinkDialog(invoice) {
 const meta = INVOICE_KIND_META[invoice.kind] || INVOICE_KIND_META.servico;
 const wantType = meta.direction === "emitida" ? "receber" : "pagar";

 els.invoiceLinkId.value = invoice.id;
 els.invoiceLinkTitle.textContent = `Vincular NF ${invoice.number} a lan?amentos`;
 els.invoiceLinkSummary.textContent = `Valor cont?bil da NF: ${money(invoice.accountingValue)}`;
 hydrateProjectOptions();
 els.invoiceLinkProject.value = invoice.projectId || "";

 const candidates = state.transactions
  .filter((item) => item.type === wantType)
  .filter((item) => !item.invoiceId || item.invoiceId === invoice.id)
  .filter((item) => !invoice.personId || item.personId === invoice.personId)
  .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

 els.invoiceLinkList.innerHTML = candidates.length ?
   candidates.map((item) => `
   <label class="checkbox-line invoice-link-row">
    <input type="checkbox" data-link-transaction="${item.id}" ${item.invoiceId === invoice.id ? "checked" : ""} />
    ${formatDate(item.dueDate)} ? ${escapeHtml(item.description)} ? ${money(item.amount)} ? ${statusLabel(item.status)} ?
   </label>`).join("")
  : emptyMessage("Nenhum lan?amento compatével (mesmo cliente/fornecedor, sem NF vinculada).");

 els.invoiceLinkDialog.showModal();
}

function saveInvoiceLink() {
 if (!guardViewAccess("notasfiscais")) return;
 const invoiceId = els.invoiceLinkId.value;
 const invoice = state.invoices.find((item) => item.id === invoiceId);
 if (invoice) invoice.projectId = els.invoiceLinkProject.value;
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
 toast("V?nculo atualizado.");
}

function renderPeople() {
 const search = document.querySelector("#peopleSearch").value.toLowerCase().trim();
 const people = state.people
  .filter((person) => `${person.name} ${person.document} ${person.contact}`.toLowerCase().includes(search))
  .sort((a, b) => a.name.localeCompare(b.name));

 document.querySelector("#peopleList").innerHTML = people.length ?
   people.map((person) => `
   <article class="person-item">
    <strong><span>${escapeHtml(person.name)}</span><span>${personTypeLabel(person.type)}</span></strong>
    <span class="muted">${escapeHtml(person.document || "Sem documento")} ? ${escapeHtml(person.contact || "Sem contato")}</span>
    <div class="row-actions">
     <button type="button" data-person-action="edit" data-id="${person.id}">Editar</button>
     <button type="button" data-person-action="delete" data-id="${person.id}">Excluir</button>
    </div> ?
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
  toast("Não ? possível excluir: h? lan?amentos vinculados.");
  return;
 }

 state.people = state.people.filter((item) => item.id !== id);
 persist();
 renderAll();
 toast("Cadastro exclu?do.");
}

function openTransactionDialog(item = null) {
 els.transactionForm.reset();
 els.transactionId.value = item.id || "";
 els.transactionType.value = item.type || "receber";
 hydratePersonOptions();
 hydrateProjectOptions();
 hydrateStatusOptions();
 els.transactionPerson.value = item.personId || els.transactionPerson.value;
 els.transactionDescription.value = item.description || "";
 els.transactionCategory.value = item.category || "";
 els.transactionDreGroup.value = item.dreGroup || defaultDreGroup(els.transactionType.value);
 els.transactionDueDate.value = item.dueDate || todayIso;
 els.transactionAmount.value = item.amount || "";
 els.transactionStatus.value = item.status || "aberto";
 els.transactionPaidDate.value = item.paidDate || "";
 els.transactionDirectProjectCost.checked = Boolean(item.directProjectCost);
 const allocations = item.allocations || [];
 els.transactionProjectMode.value = allocations.length > 1 ? "split" : allocations.length === 1 ? "single" : "none";
 els.transactionProject.value = allocations[0].projectId || "";
 els.transactionUseInstallments.checked = false;
 els.transactionEntryAmount.value = 0;
 els.transactionInstallments.value = 1;
 els.transactionInstallmentInterval.value = "monthly";
 els.transactionCustomDays.value = 30;
 renderAllocationControls();
 renderAllocationRows(allocations);
 updateTransactionInstallmentUi();
 els.transactionNotes.value = item.notes || "";
 els.transactionTitle.textContent = item ? "Editar lan?amento" : "Novo lan?amento";
 els.transactionDialog.showModal();
}

function saveTransaction() {
 const type = els.transactionType.value;
 if (!guardViewAccess(type === "receber" ? "receber" : "pagar")) return;
 const status = els.transactionStatus.value;
 const existing = state.transactions.find((item) => item.id === els.transactionId.value);
 const allocations = getTransactionAllocations();
 if (!validateAllocations(Number(els.transactionAmount.value), allocations)) {
  toast("A soma do rateio precisa ser igual ao valor total do lan?amento.");
  return;
 }

 const shouldGenerateInstallments =
  type === "receber" &&
  !existing &&
  els.transactionUseInstallments.checked &&
  (Number(els.transactionInstallments.value || 1) > 1 || Number(els.transactionEntryAmount.value || 0) > 0);

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
  saleId: existing.saleId || "",
  installmentNumber: existing.installmentNumber || "",
  installmentTotal: existing.installmentTotal || "",
  bankMovementId: existing.bankMovementId || "",
  updatedAt: new Date().toISOString(),
 };

 const index = state.transactions.findIndex((item) => item.id === data.id);
 if (index >= 0) state.transactions[index] = data;
 else state.transactions.push(data);

 persist();
 renderAll();
 els.transactionDialog.close();
 toast("Lan?amento salvo.");
}

function saveTransactionInstallments(type, status, allocations) {
 const total = Number(els.transactionAmount.value);
 let installments = getEditedTransactionInstallments();
 if (!installments.length) {
  renderTransactionInstallmentPreview();
  installments = getEditedTransactionInstallments();
 }
 const rowsTotal = roundCurrency(sum(installments.map((item) => item.amount)));
 if (Math.abs(roundCurrency(total - rowsTotal)) >= 0.01) {
  toast("A soma das parcelas precisa ser igual ao valor total da venda.");
  return;
 }
 const parcelTotal = installments.filter((item) => item.label !== "Entrada").length;
 const count = installments.length;
 const batchId = crypto.randomUUID();

 installments.forEach((installment) => {
  const installmentAllocations = scaleAllocations(allocations, installment.amount, total);
  state.transactions.push({
   id: crypto.randomUUID(),
   type,
   personId: els.transactionPerson.value,
   description: `${els.transactionDescription.value.trim()} - ${installment.label === "Entrada" ? "Entrada" : `Parcela ${installment.label}`}`,
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
   installmentNumber: installment.label === "Entrada" ? "entrada" : installment.number,
   installmentTotal: installment.label === "Entrada" ? parcelTotal : installment.total,
   bankMovementId: "",
   updatedAt: new Date().toISOString(),
  });
 });

 persist();
 renderAll();
 els.transactionDialog.close();
 toast(`${count} previs?es geradas em contas a receber.`);
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
 els.transactionPerson.innerHTML = people.length ?
   people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
  : `<option value="">Cadastre ${type === "receber" ? "um cliente" : "um fornecedor"} primeiro</option>`;
}

function createPersonFromTransactionDialog() {
 const type = els.transactionType.value === "receber" ? "cliente" : "fornecedor";
 const name = personName(els.transactionPerson.value);
 quickPersonTarget = "transaction";
 els.quickPersonForm.reset();
 els.quickPersonType.value = type;
 els.quickPersonName.value = name === "Não informado" ? "" : name;
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function createPersonFromOpportunityDialog() {
 quickPersonTarget = "opportunity";
 els.quickPersonForm.reset();
 els.quickPersonType.value = "cliente";
 els.quickPersonName.value = personName(els.opportunityPerson.value) === "Sem cadastro" ? "" : personName(els.opportunityPerson.value);
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function createPersonFromProjectForm() {
 quickPersonTarget = "project";
 els.quickPersonForm.reset();
 els.quickPersonType.value = "cliente";
 els.quickPersonName.value = "";
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function createPersonFromQuickProjectDialog() {
 quickPersonTarget = "quickProject";
 els.quickPersonForm.reset();
 els.quickPersonType.value = "cliente";
 els.quickPersonName.value = "";
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function createSupplierFromStockEntryDialog() {
 quickPersonTarget = "stockEntrySupplier";
 els.quickPersonForm.reset();
 els.quickPersonType.value = "fornecedor";
 els.quickPersonName.value = "";
 els.quickPersonDialog.showModal();
 els.quickPersonName.focus();
}

function saveQuickPersonFromTransaction() {
 const person = {
  id: crypto.randomUUID(),
  type: els.quickPersonType.value,
  name: els.quickPersonName.value.trim(),
  document: els.quickPersonDocument.value.trim(),
  contact: els.quickPersonContact.value.trim(),
 };

 state.people.push(person);
 persist();
 hydratePersonOptions();
 hydrateSalePeople();
 hydrateProjectOptions();
 hydrateInvoicePersonOptions();
 hydrateStockCatalogOptions();
 renderPeople();
 if (quickPersonTarget === "project") {
  els.projectCustomer.value = person.id;
  refreshSearchableSelect(els.projectCustomer);
 } else if (quickPersonTarget === "quickProject") {
  hydrateProjectOptions();
  els.quickProjectCustomer.value = person.id;
 } else if (quickPersonTarget === "opportunity") {
  hydrateCrmOptions();
  els.opportunityPerson.value = person.id;
 } else if (quickPersonTarget === "stockEntrySupplier") {
  els.stockEntrySupplier.value = person.id;
 } else if (quickPersonTarget === "protocol") {
  hydrateProtocolOptions();
  els.protocolCustomer.value = person.id;
 } else {
  els.transactionPerson.value = person.id;
 }
 els.quickPersonDialog.close();
 quickPersonTarget = "transaction";
 toast("Cadastro salvo e selecionado.");
}

function createProjectFromTransactionDialog() {
 if (!guardViewAccess("projetos")) return;
 const suggested = els.transactionDescription.value || personName(els.transactionPerson.value);
 const amount = Number(els.transactionAmount.value || 0);
 quickProjectTarget = "transaction";
 hydrateProjectOptions();
 els.quickProjectForm.reset();
 els.quickProjectName.value = suggested === "Não informado" ? "" : suggested;
 els.quickProjectCustomer.value = els.transactionType.value === "receber" ? els.transactionPerson.value : "";
 els.quickProjectStatus.value = "ativo";
 els.quickProjectStartDate.value = todayIso;
 els.quickProjectContractValue.value = els.transactionType.value === "receber" ? amount : 0;
 els.quickProjectExpectedCosts.value = els.transactionType.value === "pagar" ? amount : 0;
 els.quickProjectTargetMargin.value = 20;
 els.quickProjectNotes.value = "Criado a partir do lan?amento financeiro.";
 els.quickProjectDialog.showModal();
 els.quickProjectName.focus();
}

function saveQuickProjectFromTransaction() {
 const id = crypto.randomUUID();
 const project = {
  id,
  code: "",
  name: els.quickProjectName.value.trim(),
  customerId: els.quickProjectCustomer.value,
  status: els.quickProjectStatus.value,
  startDate: els.quickProjectStartDate.value,
  endDate: els.quickProjectEndDate.value,
  contractValue: Number(els.quickProjectContractValue.value || 0),
  expectedCosts: Number(els.quickProjectExpectedCosts.value || 0),
  targetMargin: Number(els.quickProjectTargetMargin.value || 0),
  costCenterId: crypto.randomUUID(),
  notes: els.quickProjectNotes.value.trim(),
 };

 state.projects.push(project);
 upsertCostCenter(project);
 persist();
 hydrateProjectOptions();
 if (quickProjectTarget === "stockExit") {
  els.stockExitProject.value = project.id;
  refreshSearchableSelect(els.stockExitProject);
  setStockTab("saida");
 } else if (quickProjectTarget === "bank") {
  els.bankProject.value = project.id;
  refreshSearchableSelect(els.bankProject);
 } else {
  els.transactionProjectMode.value = "single";
  els.transactionProject.value = project.id;
  renderAllocationControls();
 }
 renderProjects();
 renderProjectReports();
 renderHomologation();
 els.quickProjectDialog.close();
 toast(
  quickProjectTarget === "stockExit" ? "Projeto cadastrado e selecionado na saída de estoque."
   : quickProjectTarget === "bank" ? "Projeto cadastrado e selecionado na conciliação bancária."
    : "Projeto cadastrado e selecionado no lan?amento."
 );
 quickProjectTarget = "transaction";
}

function updateTransactionInstallmentUi() {
 const isReceivable = els.transactionType.value === "receber";
 const enabled = isReceivable && els.transactionUseInstallments.checked;
 els.transactionInstallmentBox.classList.toggle("hidden", !isReceivable);
 els.transactionEntryAmount.disabled = !enabled;
 els.transactionInstallments.disabled = !enabled;
 els.transactionInstallmentInterval.disabled = !enabled;
 els.transactionCustomDays.disabled = !enabled || els.transactionInstallmentInterval.value !== "custom";
 els.transactionCustomDaysWrap.classList.toggle("hidden", !enabled || els.transactionInstallmentInterval.value !== "custom");
 renderTransactionInstallmentPreview();
}

function renderTransactionInstallmentPreview() {
 if (!els.transactionUseInstallments.checked || els.transactionType.value !== "receber") {
  els.transactionInstallmentPreview.innerHTML = emptyMessage("Marque Gerar parcelas para dividir este receb?vel.");
  return;
 }
 const total = Number(els.transactionAmount.value || 0);
 const count = Number(els.transactionInstallments.value || 1);
 const firstDue = els.transactionDueDate.value;
 if (!total || !count || !firstDue) {
  els.transactionInstallmentPreview.innerHTML = emptyMessage("Informe valor, vencimento e quantidade para visualizar as parcelas.");
  return;
 }
 const entryAmount = roundCurrency(Number(els.transactionEntryAmount.value || 0));
 if (entryAmount >= total) {
  els.transactionInstallmentPreview.innerHTML = emptyMessage("O valor de entrada precisa ser menor que o valor total.");
  return;
 }
 const installments = buildTransactionInstallmentPlan(total, count, firstDue, entryAmount);
 const rowsTotal = roundCurrency(sum(installments.map((item) => item.amount)));
 els.transactionInstallmentPreview.innerHTML = `
  <strong>Previs?o das parcelas</strong>
  <div class="editable-installments">
   ${installments.map((item, index) => `
    <div class="editable-installment-row">
     <span>${escapeHtml(item.label)}</span>
     <input data-installment-date type="date" value="${item.dueDate}" />
     <input data-installment-amount type="number" min="0.01" step="0.01" value="${item.amount.toFixed(2)}" />
    </div>`).join("")}
  </div>
  <small class="allocation-total ${Math.abs(total - rowsTotal) >= 0.01 ? "invalid" : ""}">Total das parcelas: ${money(rowsTotal)} ? Diferen?a: ${money(roundCurrency(total - rowsTotal))}</small>`;
 els.transactionInstallmentPreview.querySelectorAll("[data-installment-amount]").forEach((input) => {
  input.addEventListener("input", updateEditedInstallmentTotal);
 });
}

function updateEditedInstallmentTotal() {
 const total = roundCurrency(Number(els.transactionAmount.value || 0));
 const rowsTotal = roundCurrency(sum(getEditedTransactionInstallments().map((item) => item.amount)));
 const diff = roundCurrency(total - rowsTotal);
 const totalEl = els.transactionInstallmentPreview.querySelector(".allocation-total");
 if (!totalEl) return;
 totalEl.textContent = `Total das parcelas: ${money(rowsTotal)} ? Diferen?a: ${money(diff)}`;
 totalEl.classList.toggle("invalid", Math.abs(diff) >= 0.01);
}

function buildTransactionInstallmentPlan(total, count, firstDue, entryAmount) {
 const interval = els.transactionInstallmentInterval.value;
 const customDays = Number(els.transactionCustomDays.value);
 const plan = [];
 if (entryAmount > 0) {
  plan.push({ label: "Entrada", number: 0, amount: entryAmount, dueDate: firstDue });
 }
 const remaining = roundCurrency(total - entryAmount);
 const firstInstallmentDate = entryAmount > 0 ?
   toIso(nextInstallmentDate(parseDate(firstDue), 1, interval, customDays))
  : firstDue;
 buildInstallments(remaining, count, firstInstallmentDate, interval, customDays).forEach((installment) => {
  plan.push({
   ...installment,
   label: `${installment.number}/${count}`,
  });
 });
 return plan;
}

function getEditedTransactionInstallments() {
 return [...els.transactionInstallmentPreview.querySelectorAll(".editable-installment-row")]
  .map((row, index) => {
   const label = row.querySelector("span").textContent || `${index + 1}`;
   const match = label.match(/^(\d+)\/(\d+)/);
   return {
    number: match ? Number(match[1]) : 0,
    total: match ? Number(match[2]) : 0,
    label,
    dueDate: row.querySelector("[data-installment-date]").value,
    amount: roundCurrency(Number(row.querySelector("[data-installment-amount]").value || 0)),
   };
  })
  .filter((item) => item.dueDate && item.amount > 0);
}

function hydrateSalePeople() {
 const people = state.people.filter((person) => person.type === "cliente" || person.type === "ambos");
 els.salePerson.innerHTML = people.length ?
   people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
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
 row.querySelector("[data-allocation-project]").value = allocation.projectId || state.projects[0].id || "";
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
 els.allocationTotal.textContent = `Total rateado: ${money(total)} ? Diferen?a: ${money(diff)}`;
 els.allocationTotal.classList.toggle("invalid", allocations.length > 0 && Math.abs(diff) >= 0.01);
}

function renderReports() {
 const period = getReportPeriod();
 const periodTransactions = state.transactions.filter((item) => isInPeriod(item.dueDate, period.start, period.end));
 const receberPeriod = periodTransactions.filter((item) => item.type === "receber");
 const pagarPeriod = periodTransactions.filter((item) => item.type === "pagar");
 const bankOnly = els.dreBasis.value === "caixa" ?
   state.bankMovements.filter((item) => item.category && !item.transactionId && isInPeriod(item.date, period.start, period.end))
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
   <span class="muted">${servico.length} nota(s) emitida(s) no per?odo</span>
  </article>
  <article class="report-item">
   <strong><span>NF de Material/Produto</span><span>${money(materialTotal)}</span></strong>
   <span class="muted">${material.length} nota(s) emitida(s) no per?odo</span>
  </article>
  <article class="report-item">
   <strong><span>Total geral faturado</span><span>${money(servicoTotal + materialTotal)}</span></strong>
   <span class="muted">${servico.length + material.length} nota(s) no total</span>
  </article>`;
}

function renderInvoiceExpenseReport(despesa) {
 const total = sum(despesa.map(accountingValueOf));
 document.querySelector("#invoiceExpenseReport").innerHTML = despesa.length ? `<article class="report-item">
    <strong><span>NF de despesa recebidas</span><span>${money(total)}</span></strong>
    <span class="muted">${despesa.length} nota(s) no per?odo</span>
   </article>`
  : emptyMessage("Nenhuma NF de despesa recebida no per?odo.");
}

function renderExpenseNoInvoiceReport(period) {
 const rows = state.transactions
  .filter((item) => item.type === "pagar" && !item.invoiceId && isInPeriod(item.dueDate, period.start, period.end))
  .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
 document.querySelector("#expenseNoInvoiceReport").innerHTML = rows.length ?
   rows.map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${statusLabel(item.status)}</span>
   </article>`).join("")
  : emptyMessage("Todas as despesas do per?odo t?m NF vinculada.");
}

function renderPaidNoInvoiceReport(period) {
 const rows = state.transactions
  .filter((item) => item.type === "pagar" && item.status === "pago" && !item.invoiceId && isInPeriod(item.paidDate, period.start, period.end))
  .sort((a, b) => a.paidDate.localeCompare(b.paidDate));
 document.querySelector("#paidNoInvoiceReport").innerHTML = rows.length ?
   rows.map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.paidDate)} ? ${personName(item.personId)}</span>
   </article>`).join("")
  : emptyMessage("Nenhuma conta paga sem NF no per?odo.");
}

function renderReceivableNoInvoiceReport(period) {
 const rows = state.transactions
  .filter((item) => item.type === "receber" && !item.invoiceId && isInPeriod(item.dueDate, period.start, period.end))
  .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
 document.querySelector("#receivableNoInvoiceReport").innerHTML = rows.length ?
   rows.map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${statusLabel(item.status)}</span>
   </article>`).join("")
  : emptyMessage("Todas as contas a receber do per?odo t?m NF vinculada.");
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
 document.querySelector("#invoiceByProjectReport").innerHTML = rows.length ?
   rows.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
    <span class="muted">${row.count} NF</span> ?
   </article>`).join("")
  : emptyMessage("Sem dados para este relatério.");
}

function renderInvoiceByClientReport(invoices) {
 const rows = groupInvoicesBy(invoices, "personId", personName);
 document.querySelector("#invoiceByClientReport").innerHTML = rows.length ?
   rows.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
    <span class="muted">${row.count} NF</span> ?
   </article>`).join("")
  : emptyMessage("Sem dados para este relatério.");
}

function renderInvoiceBySupplierReport(despesa) {
 const rows = groupInvoicesBy(despesa, "personId", personName);
 document.querySelector("#invoiceBySupplierReport").innerHTML = rows.length ?
   rows.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.name)}</span><span>${money(row.total)}</span></strong>
    <span class="muted">${row.count} NF</span> ?
   </article>`).join("")
  : emptyMessage("Sem dados para este relatério.");
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

 document.querySelector("#invoiceDivergenceReport").innerHTML = rows.length ?
   rows.map((row) => `
   <tr class="invoice-divergence-row ${Math.abs(row.diff) > 0.01 ? "mismatch" : ""}">
    <td>NF ${escapeHtml(row.invoice.number)} ? ${escapeHtml(personName(row.invoice.personId))}</td>
    <td>${row.linkedCount} parcela(s)</td>
    <td class="money">${money(row.invoice.accountingValue)}</td>
    <td class="money">${money(row.financialTotal)}</td>
    <td class="money">${money(row.diff)}</td> ?
   </tr>`).join("")
  : `<tr><td colspan="5">${emptyMessage("Nenhuma NF vinculada a lan?amentos para comparar.")}</td></tr>`;
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
   <span>Resultado l?quido</span>
   <strong>${money(dre.result)}</strong>
  </article>`;
}

function renderPeriodReport(targetId, rows) {
 document.querySelector(`#${targetId}`).innerHTML = rows.length ?
   rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${statusLabel(item.status)}</span> ?
   </article>`).join("")
  : emptyMessage("Nenhum lan?amento no per?odo.");
}

function renderCategoryReport(periodTransactions) {
 const type = document.querySelector("#categoryReportType").value;
 const byCategory = groupByCategory(periodTransactions.filter((item) => item.type === type));
 document.querySelector("#categoryReport").innerHTML = byCategory.length ?
   byCategory.map((row) => `
   <article class="report-item">
    <strong><span>${escapeHtml(row.category)}</span><span>${money(row.total)}</span></strong>
    <span class="muted">${row.count} lan?amento(s)</span> ?
   </article>`).join("")
  : emptyMessage("Sem dados para este relatério.");
}

function renderOverdueReport() {
 const overdue = state.transactions.filter(isOverdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
 document.querySelector("#overdueReport").innerHTML = overdue.length ?
   overdue.map((item) => `
   <article class="report-item">
    <strong><span>${escapeHtml(item.description)}</span><span>${money(item.amount)}</span></strong>
    <span class="muted">${formatDate(item.dueDate)} ? ${personName(item.personId)} ? ${item.type === "receber" ? "A receber" : "A pagar"}</span>
   </article>`).join("")
  : emptyMessage("Nenhum lan?amento vencido em aberto.");
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
   toast("Arquivo inv?lido.");
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
  state.bankApiConfigs = data.bankApiConfigs;
  state.transactions = data.transactions;
  state.invoices = data.invoices;
  state.stockItems = data.stockItems;
  state.stockMovements = data.stockMovements;
  state.stockLocations = data.stockLocations;
  state.installations = data.installations;
  state.utilityCompanies = data.utilityCompanies;
  state.protocolActivityTypes = data.protocolActivityTypes;
  state.protocols = data.protocols;
  state.protocolHistory = data.protocolHistory;
  persist("all");
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
  const rows = [["grupo", "valor"], ...dreGroups.map((group) => [group.label, dre.groups[group.key] || 0]), ["Resultado l?quido", dre.result]];
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
 return dreGroups.find((group) => group.key === key).label || "Outros";
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

function formatNumber(value, fractionDigits = 2) {
 return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: fractionDigits }).format(Number(value || 0));
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
