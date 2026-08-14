// Modulo ES separado (carregado com <script type="module">) so para poder usar
// `import` do SDK do Vercel Blob sem precisar de bundler no resto do app, que
// continua em scripts classicos (app.js). Expoe um unico helper em window,
// usado por uploadOpportunityFile() em app.js.
import { upload } from "https://esm.sh/@vercel/blob@0.27.1/client";

window.uploadOpportunityFileToBlob = async function uploadOpportunityFileToBlob(file, pathname) {
  const blob = await upload(pathname, file, {
    access: "public",
    handleUploadUrl: "/api/crm-upload",
  });
  return blob;
};
