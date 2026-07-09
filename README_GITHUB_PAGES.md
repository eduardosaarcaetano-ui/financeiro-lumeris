# Publicacao no GitHub Pages

Este sistema e um app estatico. Para publicar no GitHub Pages, mantenha estes arquivos na raiz do repositorio:

- `index.html`
- `styles.css`
- `app.js`

## Passo a passo

1. Crie um repositorio no GitHub.
2. Envie os arquivos deste projeto para o repositorio.
3. No GitHub, acesse `Settings > Pages`.
4. Em `Build and deployment`, selecione:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/ (root)`
5. Salve.

Depois de alguns minutos, o GitHub Pages vai liberar um link parecido com:

`https://seu-usuario.github.io/nome-do-repositorio/`

## Observacao importante

Os dados do sistema ficam salvos no navegador de quem usa, via `localStorage`, e (se configurado) sincronizados com uma planilha Google compartilhada — veja abaixo.

## Compartilhar dados entre todos os usuários (Google Sheets + Drive)

O arquivo `AppsScript_Code.gs` deste projeto guarda o estado inteiro do sistema num arquivo JSON no Google Drive (não numa célula da planilha — o histórico de movimentos bancários importados via OFX cresce e ultrapassaria o limite de 50.000 caracteres por célula). A planilha só serve de ponto de partida para o projeto do Apps Script; o arquivo de dados é criado automaticamente na mesma pasta do Drive onde ela estiver.

1. Crie uma planilha nova em [sheets.google.com](https://sheets.google.com).
2. Nela, vá em `Extensões > Apps Script`.
3. Apague o conteúdo padrão do editor e cole o conteúdo do arquivo `AppsScript_Code.gs`.
4. Clique em `Implantar > Nova implantação`.
5. Em "Selecionar tipo", escolha `App da Web`.
6. Configure:
   - Executar como: `Eu` (sua conta)
   - Quem pode acessar: `Qualquer pessoa`
7. Clique em `Implantar` e autorize as permissões pedidas (agora inclui acesso ao Google Drive, além da planilha — é o seu próprio script, pode aceitar).
8. Copie a URL gerada (termina em `/exec`).
9. Abra `app.js` neste projeto e cole a URL na constante `SHEETS_ENDPOINT`, no topo do arquivo:
   ```js
   const SHEETS_ENDPOINT = "https://script.google.com/macros/s/SEU_ID/exec";
   ```
10. Publique/atualize o `app.js` (GitHub Pages, etc.). Pronto — todos que acessarem o link passam a ler e gravar no mesmo arquivo de dados.

Se você já tinha implantado uma versão antiga do `Code.gs` (que gravava numa célula da planilha), edite o código no editor do Apps Script, cole o conteúdo atualizado, e em `Implantar > Gerenciar implantações` escolha a implantação existente, clique no lápis e crie uma `Nova versão` — a URL `/exec` continua a mesma, só o comportamento interno muda.

Detalhes de funcionamento:

- Ao abrir o app, ele busca os dados mais recentes (do arquivo no Drive) e substitui o que estava salvo localmente.
- Cada alteração é salva primeiro no navegador (instantâneo) e enviada para o Drive em segundo plano (indicador no topo da tela mostra o status).
- Se dois usuários salvarem ao mesmo tempo, o segundo recebe um aviso de conflito pedindo para recarregar a página antes de continuar, evitando sobrescrever dados sem perceber.
- Sem `SHEETS_ENDPOINT` preenchido, o app funciona como antes, só no navegador local.
