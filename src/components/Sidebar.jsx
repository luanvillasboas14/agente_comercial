import { Sparkles, LayoutDashboard, FileText, FlaskConical, ListChecks, Settings, Star, BarChart3 } from 'lucide-react'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'prompts', label: 'Prompts', icon: FileText },
  { id: 'playground', label: 'Teste IA', icon: FlaskConical },
  { id: 'executions', label: 'Execuções', icon: ListChecks },
  { id: 'feedback', label: 'Feedback Comercial', icon: Star },
  { id: 'feedback-dashboard', label: 'Dashboard Feedback', icon: BarChart3 },
]

export default function Sidebar({ page, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Sparkles size={16} />
        </div>
        <div className="brand-text">
          <div className="brand-title">Agente Comercial</div>
          <div className="brand-sub">Painel da IA</div>
        </div>
      </div>

      <div className="nav-section">Geral</div>
      <nav className="nav-list">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item${page === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon size={16} className="nav-icon" />
            <span className="nav-item-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="nav-footer">
        <div className="workspace">
          <div className="workspace-avatar">AC</div>
          <div className="workspace-info">
            <div className="workspace-name">Produção</div>
            <div className="workspace-status">online</div>
          </div>
        </div>
        <button className="btn-icon" style={{ width: 28, height: 28 }}>
          <Settings size={14} />
        </button>
      </div>
    </aside>
  )
}
