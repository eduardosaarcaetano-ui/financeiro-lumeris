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

Os dados do sistema ficam salvos no navegador de quem usa, via `localStorage`. Para uso por varias pessoas com dados compartilhados, sera necessario migrar para um banco de dados online.
