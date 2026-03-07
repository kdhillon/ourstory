const STORAGE_KEY = 'openhistory_welcome_seen';

interface Props {
  onClose: () => void;
}

export function WelcomeModal({ onClose }: Props) {
  const handleClose = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.title}>Welcome to OpenHistory</div>
        </div>

        <div style={styles.body}>
          <p style={styles.lead}>
            An open-source interactive atlas of human history. Scroll through history and learn
            the story of humankind.
          </p>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Help improve territory labels</div>
            <p style={styles.text}>
              Territory polygons show which polities controlled which land at a given time.
              Unassigned territories show a <em style={{ color: '#888', fontStyle: 'italic' }}>grey italic label</em> — you can help by linking them to the correct polity,
              turning them <em style={{ color: '#f5c518', fontStyle: 'italic', fontWeight: 700, WebkitTextStroke: '0.5px #333' }}>yellow and bold</em>.
            </p>

            <div style={styles.screenshotRow}>
              <div style={styles.screenshotItem}>
                <img src="/territory-unassigned.png" alt="Unassigned territory — grey italic label" style={styles.screenshot} />
                <div style={styles.screenshotCaption}>Unassigned — <em>grey italic</em></div>
              </div>
              <div style={styles.screenshotArrow}>→</div>
              <div style={styles.screenshotItem}>
                <img src="/territory-assigned.png" alt="Assigned territory — yellow bold label" style={styles.screenshot} />
                <div style={styles.screenshotCaption}>Assigned — <em style={{ color: '#c8a000', fontWeight: 700 }}>yellow bold</em></div>
              </div>
            </div>

          </div>

        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={handleClose}>
            Got it, let me explore
          </button>
        </div>
      </div>
    </div>
  );
}

export function shouldShowWelcome(): boolean {
  try {
    return !localStorage.getItem(STORAGE_KEY);
  } catch {
    return true;
  }
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modal: {
    background: '#ffffff',
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    width: '100%',
    maxWidth: 480,
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '20px 24px 16px',
    borderBottom: '1px solid rgba(0,0,0,0.07)',
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    color: '#202122',
    letterSpacing: '-0.02em',
  },
  body: {
    padding: '16px 24px',
    overflowY: 'auto',
    flex: 1,
  },
  lead: {
    fontSize: 14,
    color: '#54595d',
    lineHeight: 1.6,
    margin: '0 0 16px',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: '#54595d',
    marginBottom: 8,
  },
  text: {
    fontSize: 14,
    color: '#202122',
    lineHeight: 1.65,
    margin: '0 0 8px',
  },
  note: {
    fontSize: 13,
    color: '#54595d',
    lineHeight: 1.55,
    background: '#f8f9fa',
    border: '1px solid rgba(0,0,0,0.09)',
    borderRadius: 6,
    padding: '10px 14px',
    marginTop: 8,
  },
  screenshotRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '12px 0',
  },
  screenshotItem: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 6,
  },
  screenshot: {
    width: '100%',
    borderRadius: 6,
    border: '1px solid rgba(0,0,0,0.1)',
  },
  screenshotCaption: {
    fontSize: 12,
    color: '#54595d',
    textAlign: 'center' as const,
  },
  screenshotArrow: {
    fontSize: 20,
    color: '#54595d',
    flexShrink: 0,
  },
  footer: {
    padding: '14px 24px',
    borderTop: '1px solid rgba(0,0,0,0.07)',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  btn: {
    background: '#3366cc',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    padding: '9px 20px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
