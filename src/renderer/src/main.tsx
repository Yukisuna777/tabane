import ReactDOM from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

// StrictMode の二重マウントは PTY を余計に spawn/kill させるため、あえて使わない。
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
