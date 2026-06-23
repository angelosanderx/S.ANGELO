#!/usr/bin/env node
/**
 * importar_links_guia.js
 * Lê os PDFs do Guia de Estudo da pasta /apoio e extrai links dos cadernos TEC.
 * Coleção: `disciplinas`, campo `cadernos_tec` (array, merge: true)
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

const admin    = require('firebase-admin');
const PDFParser = require('pdf2json');

// ── Inicializar Firebase Admin ───────────────────────────────────────────────
const serviceAccount = require(keyPath);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Mapeamento disciplina (texto PDF) → slug ─────────────────────────────────
const DISC_MAP = {
  'DIREITO ADMINISTRATIVO': 'd_administrativo',
  'DIREITO CONSTITUCIONAL': 'd_constitucional',
  'DIREITO TRIBUTÁRIO':     'd_tributario',
  'CONTABILIDADE GERAL':    'contabilidade_geral',
  'PORTUGUÊS':              'portugues',
  'RACIOCÍNIO LÓGICO':      'raciocinio_logico',
  'AUDITORIA FISCAL':       'auditoria_fiscal',
  'FLUÊNCIA DE DADOS':      'fluencia_dados',
};

// Normalizar texto para comparação (remove acentos, upper)
function normalizar(str) {
  return (str || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Mapa normalizado para lookup
const DISC_MAP_NORM = {};
for (const [k, v] of Object.entries(DISC_MAP)) {
  DISC_MAP_NORM[normalizar(k)] = v;
}

function resolverDiscSlug(texto) {
  const norm = normalizar(texto);
  // Busca exata
  if (DISC_MAP_NORM[norm]) return DISC_MAP_NORM[norm];
  // Busca parcial
  for (const [k, v] of Object.entries(DISC_MAP_NORM)) {
    if (norm.includes(k) || k.includes(norm)) return v;
  }
  return null;
}

// ── Bancas conhecidas ─────────────────────────────────────────────────────────
const BANCAS = ['FGV', 'FCC', 'CESPE', 'CEBRASPE', 'VUNESP', 'ESAF', 'CESGRANRIO'];

function detectarBanca(texto) {
  const upper = (texto || '').toUpperCase();
  for (const b of BANCAS) {
    if (upper.includes(b)) return b === 'CEBRASPE' ? 'CESPE' : b;
  }
  return 'Outras';
}

// ── Rótulos conhecidos ────────────────────────────────────────────────────────
const ROTULOS_RE = [
  /bloco\s+i+v?\b/i,
  /bloco\s+\d+/i,
  /caderno\s+completo/i,
  /gabarito/i,
  /simulado/i,
  /caderno\s+\d+/i,
];

function detectarRotulo(texto) {
  for (const re of ROTULOS_RE) {
    const m = texto.match(re);
    if (m) return m[0];
  }
  return texto.trim().slice(0, 40) || 'Link';
}

// ── Parsear um PDF com pdf2json ───────────────────────────────────────────────
function parsearPDF(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1); // 1 = verbatim text

    parser.on('pdfParser_dataError', err => reject(new Error(err.parserError || String(err))));

    parser.on('pdfParser_dataReady', data => {
      const pages = data.Pages || data.formImage?.Pages || [];
      const resultado = []; // { discSlug, banca, rotulo, nome, url }

      for (const page of pages) {
        // Extrair textos da página em ordem
        const textos = (page.Texts || []).map(t => {
          const str = t.R ? t.R.map(r => decodeURIComponent(r.T || '')).join('') : '';
          return { x: t.x, y: t.y, str };
        });

        // Extrair URIs das annotations
        const uris = [];
        // pdf2json pode colocar anotações em page.Annots
        if (page.Annots) {
          for (const annot of page.Annots) {
            const url = annot.url || annot.URI || annot.HRef;
            if (url && url.startsWith('http')) {
              uris.push({ url, x: annot.x || 0, y: annot.y || 0 });
            }
          }
        }
        // Também verificar em page.Fields (formulários)
        if (page.Fields) {
          for (const field of page.Fields) {
            const url = field.url || field.URI;
            if (url && url.startsWith('http')) {
              uris.push({ url, x: field.x || 0, y: field.y || 0 });
            }
          }
        }

        if (!uris.length) continue;

        // Tentar identificar disciplina e banca pelos textos da página
        let discAtual  = null;
        let bancaAtual = 'Outras';

        for (const t of textos) {
          const slug = resolverDiscSlug(t.str);
          if (slug) { discAtual = slug; continue; }
          const banca = detectarBanca(t.str);
          if (banca !== 'Outras') bancaAtual = banca;
        }

        // Cruzar textos de linha (rótulos candidatos) com URIs pela proximidade vertical
        // Ordenar URIs por posição (y crescente)
        uris.sort((a, b) => a.y - b.y || a.x - b.x);

        // Para cada URI, encontrar o texto mais próximo acima ou na mesma linha
        for (const uri of uris) {
          // Textos próximos (mesma linha ± 0.5 unidade ou acima até 2 unidades)
          const candidatos = textos
            .filter(t => t.y <= uri.y + 0.5 && t.y >= uri.y - 2 && t.str.trim())
            .sort((a, b) => Math.abs(a.y - uri.y) - Math.abs(b.y - uri.y) || a.x - b.x);

          const textoProximo = candidatos.length ? candidatos[0].str : '';
          const rotulo = detectarRotulo(textoProximo);

          // Tentar detectar banca pelo texto próximo
          const bancaUri = detectarBanca(textoProximo);
          const bancaFinal = bancaUri !== 'Outras' ? bancaUri : bancaAtual;

          resultado.push({
            discSlug: discAtual,
            banca:    bancaFinal,
            rotulo,
            nome:     textoProximo.trim() || rotulo,
            url:      uri.url,
          });
        }
      }

      resolve(resultado);
    });

    parser.loadPDF(filePath);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const apoioDir = path.join(__dirname, 'apoio');
  if (!fs.existsSync(apoioDir)) {
    console.error(`❌  Pasta /apoio não encontrada em ${apoioDir}`);
    process.exit(1);
  }

  const pdfs = fs.readdirSync(apoioDir)
    .filter(f => f.toLowerCase().includes('guia') && f.endsWith('.pdf'));

  if (!pdfs.length) {
    // Tentar todos os PDFs
    const todos = fs.readdirSync(apoioDir).filter(f => f.endsWith('.pdf'));
    if (!todos.length) {
      console.log('Nenhum PDF encontrado em /apoio');
      process.exit(0);
    }
    pdfs.push(...todos);
  }

  // Agrupar entradas por disciplinaSlug
  const porDisc = {}; // slug → [{ banca, rotulo, nome, url }]

  for (const pdf of pdfs) {
    const filePath = path.join(apoioDir, pdf);
    console.log(`Processando ${pdf}...`);
    try {
      const entradas = await parsearPDF(filePath);
      for (const entrada of entradas) {
        const slug = entrada.discSlug;
        if (!slug) continue;
        if (!porDisc[slug]) porDisc[slug] = [];
        porDisc[slug].push({
          banca:  entrada.banca,
          rotulo: entrada.rotulo,
          nome:   entrada.nome,
          url:    entrada.url,
        });
      }
    } catch (e) {
      console.error(`❌  Erro ao processar ${pdf}: ${e.message}`);
    }
  }

  let totalImportadas = 0;
  let totalErros      = 0;

  for (const [slug, cadernos] of Object.entries(porDisc)) {
    // Remover duplicatas por URL
    const vistos = new Set();
    const dedup  = cadernos.filter(c => {
      if (vistos.has(c.url)) return false;
      vistos.add(c.url); return true;
    });

    try {
      await db.collection('disciplinas').doc(slug).set(
        { cadernos_tec: dedup },
        { merge: true }
      );

      // Resumo por banca
      const contBancas = {};
      for (const c of dedup) {
        contBancas[c.banca] = (contBancas[c.banca] || 0) + 1;
      }
      const resumo = Object.entries(contBancas).map(([b, n]) => `${b}: ${n}`).join(', ');
      console.log(`✅ ${slug} — ${resumo}`);
      totalImportadas++;
    } catch (e) {
      console.error(`❌ Erro em ${slug}: ${e.message}`);
      totalErros++;
    }
  }

  console.log('');
  console.log(`Concluído: ${totalImportadas} disciplinas importadas`);
  if (totalErros) console.log(`Erros: ${totalErros}`);
}

main().catch(e => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
