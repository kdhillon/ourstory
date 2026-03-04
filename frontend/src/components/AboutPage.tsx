interface Props {
  onBack: () => void;
}

export function AboutPage({ onBack }: Props) {
  return (
    <div style={styles.page}>
      <div style={styles.container}>

        {/* Header */}
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Back to map</button>
        </div>

        <h1 style={styles.h1}>OpenHistory</h1>
        <p style={styles.lead}>
          An open-source interactive atlas of human history. Scroll through time, watch events
          unfold, and explore civilizations rising and falling — all sourced from Wikipedia and Wikidata.
        </p>

        <div style={styles.statusBadge}>🚧 Work in progress — data coverage is limited and expanding</div>

        <hr style={styles.rule} />

        <h2 style={styles.h2}>Data</h2>
        <p style={styles.p}>
          All historical data comes from <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> and{' '}
          <a style={styles.a} href="https://www.wikipedia.org" target="_blank" rel="noreferrer">Wikipedia</a>, both published under open licenses
          (CC BY-SA). The pipeline fetches events, locations, and political entities via the Wikidata SPARQL API and
          Wikipedia REST API, classifies them by category, and stores them in PostgreSQL.
        </p>
        <p style={styles.p}>
          Current coverage: <strong>1790–1810</strong>. Other periods are being added progressively.
          Data quality varies — dates and locations are occasionally wrong or missing, reflecting
          the state of Wikidata itself.
        </p>

        <h2 style={styles.h2}>Open Source</h2>
        <p style={styles.p}>
          OpenHistory is fully open source under the MIT license. The code, pipeline, and data
          schema are all public.
        </p>
        <a
          style={styles.githubBtn}
          href="https://github.com/kdhillon/openhistory"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
        </a>

        <h2 style={styles.h2}>Tech Stack</h2>
        <ul style={styles.ul}>
          <li>Map: <a style={styles.a} href="https://maplibre.org" target="_blank" rel="noreferrer">MapLibre GL JS</a> with <a style={styles.a} href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> tiles</li>
          <li>Frontend: React 18, TypeScript, Vite</li>
          <li>Backend: FastAPI (Python), PostgreSQL</li>
          <li>Data: Wikidata SPARQL + Wikipedia REST API</li>
          <li>Hosting: <a style={styles.a} href="https://railway.app" target="_blank" rel="noreferrer">Railway</a></li>
        </ul>

        <h2 style={styles.h2}>Issues &amp; Contributions</h2>
        <p style={styles.p}>
          Found a data error or have a feature idea? Open an issue or pull request on{' '}
          <a style={styles.a} href="https://github.com/kdhillon/openhistory/issues" target="_blank" rel="noreferrer">GitHub</a>.
        </p>

        <hr style={styles.rule} />
        <p style={styles.footer}>
          Data © <a style={styles.a} href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata</a> contributors (CC BY-SA) ·{' '}
          Map © <a style={styles.a} href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          Code © 2026 OpenHistory contributors (MIT)
        </p>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f8f9fa',
    display: 'flex',
    justifyContent: 'center',
    padding: '40px 20px 80px',
  },
  container: {
    maxWidth: 680,
    width: '100%',
  },
  header: {
    marginBottom: 32,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#3366cc',
    fontSize: 14,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  h1: {
    fontSize: 36,
    fontWeight: 700,
    color: '#202122',
    margin: '0 0 12px',
    letterSpacing: '-0.02em',
  },
  lead: {
    fontSize: 17,
    color: '#54595d',
    lineHeight: 1.6,
    margin: '0 0 16px',
  },
  statusBadge: {
    display: 'inline-block',
    background: '#fff3cd',
    border: '1px solid #ffc107',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    color: '#664d03',
    marginBottom: 24,
  },
  rule: {
    border: 'none',
    borderTop: '1px solid rgba(0,0,0,0.1)',
    margin: '24px 0',
  },
  h2: {
    fontSize: 22,
    fontWeight: 600,
    color: '#202122',
    margin: '28px 0 10px',
    letterSpacing: '-0.01em',
  },
  p: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.7,
    margin: '0 0 14px',
  },
  ul: {
    fontSize: 15,
    color: '#202122',
    lineHeight: 1.9,
    paddingLeft: 22,
    margin: '0 0 14px',
  },
  a: {
    color: '#3366cc',
    textDecoration: 'none',
  },
  githubBtn: {
    display: 'inline-block',
    background: '#202122',
    color: '#ffffff',
    padding: '9px 18px',
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    textDecoration: 'none',
    marginBottom: 24,
  },
  footer: {
    fontSize: 13,
    color: '#54595d',
    lineHeight: 1.7,
    margin: 0,
  },
};
