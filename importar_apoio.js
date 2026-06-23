#!/usr/bin/env node
/**
 * importar_apoio.js
 * Lê arquivos .docx da pasta /apoio e importa texto de apoio das tarefas para Firestore.
 * Coleção: `tarefas`, campo `apoio` (merge: true)
 */

const path = require('path');
const fs   = require('fs');

// ── Verificar serviceAccountKey.json ────────────────────────────────────────
const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('');
  console.error('❌  serviceAccountKey.json não encontrado.');
  console.error('');
  console.error('   Para obtê-lo:');
  console.error('   1. Acesse https://console.firebase.google.com/project/pnad-c-campos/settings/serviceaccounts/adminsdk');
  console.error('   2. Clique em "Gerar nova chave privada"');
  console.error('   3. Salve o arquivo como serviceAccountKey.json na raiz do projeto');
  console.error('');
  process.exit(1);
}

const admin   = require('firebase-admin');
const mammoth = require('mammoth');

// ── Inicializar Firebase Admin ───────────────────────────────────────────────
const serviceAccount = require(keyPath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ── Mapeamento arquivo → disciplinaId slug ───────────────────────────────────
const MAPEAMENTO = [
  { regex: /constitucional/i,          slug: 'd_constitucional'   },
  { regex: /administrativo/i,          slug: 'd_administrativo'   },
  { regex: /tribut/i,                   slug: 'd_tributario'       },
  { regex: /geral|contabilidade/i,     slug: 'contabilidade_geral'},
  { regex: /portugu/i,                 slug: 'portugues'          },
];

function resolverSlug(nomeArquivo) {
  const base = path.basename(nomeArquivo, path.extname(nomeArquivo));
  for (const m of MAPEAMENTO) {
    if (m.regex.test(base)) return m.slug;
  }
  return null;
}

// ── Limpar artefatos de markdown do mammoth ──────────────────────────────────
function limparMarkdown(texto) {
  return texto
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **negrito**
    .replace(/__([^_]+)__/g, '$1')        // __negrito__
    .replace(/\*([^*]+)\*/g, '$1')        // *itálico*
    .replace(/_([^_]+)_/g, '$1')          // _itálico_
    .replace(/^\s*\*+\s*/gm, '')          // asteriscos soltos no início de linha
    .replace(/\s*\*+\s*$/gm, '')          // asteriscos soltos no final de linha
    .replace(/\*{1,3}/g, '')              // asteriscos residuais
    .replace(/_{1,3}/g, '')               // underscores residuais
    .trim();
}

// ── Parsear texto extraído do docx ───────────────────────────────────────────
function parsearTarefas(textoRaw) {
  // Remover marcadores de markdown antes de separar
  const texto = limparMarkdown(textoRaw);

  // Separar por "Tarefa N" (pode ter * ao redor, já removidos)
  const blocoRegex = /Tarefa\s+(\d+)/gi;
  const partes = [];
  let match;
  const indices = [];

  // Encontrar todas as posições de "Tarefa N"
  const textoOrig = limparMarkdown(textoRaw);
  const reIter = /Tarefa\s+(\d+)/gi;
  while ((match = reIter.exec(textoOrig)) !== null) {
    indices.push({ num: parseInt(match[1], 10), pos: match.index });
  }

  for (let i = 0; i < indices.length; i++) {
    const inicio = indices[i].pos;
    const fim    = i + 1 < indices.length ? indices[i + 1].pos : textoOrig.length;
    const bloco  = textoOrig.slice(inicio, fim).trim();
    partes.push({ num: indices[i].num, bloco });
  }

  return partes.map(({ num, bloco }) => {
    const linhas = bloco.split('\n').map(l => l.trim()).filter(Boolean);
    // Primeira linha é o cabeçalho "Tarefa N" — pular
    const corpo = linhas.slice(1);

    let titulo = '';
    let link   = '';
    const textoLinhas = [];

    for (const linha of corpo) {
      if (!titulo && !linha.toLowerCase().startsWith('link:')) {
        titulo = limparMarkdown(linha);
        continue;
      }
      if (linha.toLowerCase().startsWith('link:')) {
        // Extrair URL
        const urlMatch = linha.match(/https?:\/\/\S+/);
        if (urlMatch) link = urlMatch[0].replace(/[)>]+$/, ''); // remover trailing chars
        continue;
      }
      textoLinhas.push(limparMarkdown(linha));
    }

    const texto = textoLinhas.join('\n').trim();
    return { num, titulo, link, texto };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const apoioDir = path.join(__dirname, 'apoio');
  if (!fs.existsSync(apoioDir)) {
    console.error(`❌  Pasta /apoio não encontrada em ${apoioDir}`);
    process.exit(1);
  }

  const arquivos = fs.readdirSync(apoioDir).filter(f => f.endsWith('.docx'));
  if (!arquivos.length) {
    console.log('Nenhum arquivo .docx encontrado em /apoio');
    process.exit(0);
  }

  let totalImportadas = 0;
  let totalErros      = 0;

  for (const arquivo of arquivos) {
    const discSlug = resolverSlug(arquivo);
    if (!discSlug) {
      console.warn(`⚠️  Não foi possível mapear disciplina para: ${arquivo} — pulando`);
      continue;
    }

    const filePath = path.join(apoioDir, arquivo);
    let textoRaw;
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      textoRaw = result.value;
    } catch (e) {
      console.error(`❌  Erro ao ler ${arquivo}: ${e.message}`);
      totalErros++;
      continue;
    }

    const tarefas = parsearTarefas(textoRaw);
    if (!tarefas.length) {
      console.warn(`⚠️  Nenhuma tarefa encontrada em ${arquivo}`);
      continue;
    }

    for (const tarefa of tarefas) {
      const nn    = String(tarefa.num).padStart(2, '0');
      const docId = `${discSlug}_${nn}`;
      try {
        await db.collection('tarefas').doc(docId).set(
          {
            apoio: {
              titulo:      tarefa.titulo,
              link:        tarefa.link,
              texto:       tarefa.texto,
              importadoEm: FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );
        console.log(`✅ ${docId} — ${tarefa.titulo}`);
        totalImportadas++;
      } catch (e) {
        console.error(`❌ Erro em ${docId}: ${e.message}`);
        totalErros++;
      }
    }
  }

  console.log('');
  console.log(`Concluído: ${totalImportadas} tarefas importadas, ${totalErros} erros`);
}

main().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
