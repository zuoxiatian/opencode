import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import './index.css';

function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main class="app">
      <section class="panel">
        <p class="eyebrow">Electron Forge + Solid</p>
        <h1>desktop-forge</h1>
        <p class="lede">A Solid renderer is running inside Electron.</p>
        <button type="button" onClick={() => setCount(count() + 1)}>
          Clicks {count()}
        </button>
      </section>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

render(() => <App />, root);
