import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { App } from './App';
import { CapturePage } from './pages/CapturePage';
import { DashboardPage } from './pages/DashboardPage';
import { EntityPage } from './pages/EntityPage';
import { EntryPage } from './pages/EntryPage';
import { FrogWidgetPage } from './pages/FrogWidgetPage';
import { GraphPage } from './pages/GraphPage';
import { QueryPage } from './pages/QueryPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { WikiPage } from './pages/WikiPage';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/frog',
    element: <FrogWidgetPage />,
  },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'capture', element: <CapturePage /> },
      { path: 'entries/:id', element: <EntryPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'wiki/:type/:id', element: <EntityPage /> },
      { path: 'graph', element: <GraphPage /> },
      { path: 'reviews', element: <ReviewsPage /> },
      { path: 'query', element: <QueryPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
