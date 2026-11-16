import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { App } from './App';
import { loadCloudConfiguration } from './lib/cloud-config';
import { prepareBrowserForClass } from './lib/preparation-epoch';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
async function bootstrap() {
  const configuration = await loadCloudConfiguration();
  if (configuration.error) throw new Error(configuration.error);
  await prepareBrowserForClass(configuration.config);
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
void bootstrap().catch(() => {
  root.render(
    <main className="error-screen">
      <div className="error-box">
        <h1>Не удалось подготовить мастерскую</h1>
        <p>Закройте другие вкладки мастерской и перезагрузите страницу.</p>
        <button className="button button-primary" onClick={() => location.reload()}>
          Перезагрузить
        </button>
      </div>
    </main>,
  );
});
