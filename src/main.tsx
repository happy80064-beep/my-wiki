import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { App } from './App';
import { CapturePage } from './pages/CapturePage';
import { DashboardPage } from './pages/DashboardPage';
import { QueryPage } from './pages/QueryPage';
import { WikiPage } from './pages/WikiPage';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'capture', element: <CapturePage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'query', element: <QueryPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
