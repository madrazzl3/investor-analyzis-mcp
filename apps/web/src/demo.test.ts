import { expect, it } from 'vitest';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Demo } from './demo';

it('public demo renders synthetic content without upload, login, or freeform input controls', () => {
  const html = renderToStaticMarkup(
    createElement(Demo, { onWorkspace: () => undefined }),
  );
  expect(html).toContain('SYNTHETIC DEMO');
  expect(html).toContain('No live analysis');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('jamie@atlas.example');
  expect(html).not.toContain('samplepassword');
});
