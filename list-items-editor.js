/**
 * JSON editor for the create/edit list modal with basic syntax highlighting.
 * Loaded dynamically from app.js to keep the initial page bundle smaller.
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, drawSelection } from 'https://esm.sh/@codemirror/view@6.35.3';
import { EditorState, Compartment } from 'https://esm.sh/@codemirror/state@6.5.0';
import { defaultKeymap, history, historyKeymap } from 'https://esm.sh/@codemirror/commands@6.6.2';
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  syntaxHighlighting,
  defaultHighlightStyle,
} from 'https://esm.sh/@codemirror/language@6.10.8';
import { json } from 'https://esm.sh/@codemirror/lang-json@6.0.1';

const editorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      border: '1px solid var(--border-strong)',
      borderRadius: '4px',
      backgroundColor: 'var(--bg)',
      color: 'var(--fg)',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: 'var(--accent)',
    },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.45',
      minHeight: '110px',
      maxHeight: 'min(36vh, 320px)',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'var(--fg)', padding: '6px 0' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--fg-dim)',
      border: 'none',
      borderRight: '1px solid var(--border-strong)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 4px', minWidth: '2.2ch' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
    '.cm-activeLine': { backgroundColor: 'rgba(0, 0, 0, 0.035)' },
    '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(74, 121, 200, 0.22)' },
    '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  },
  { dark: false },
);

/**
 * @param {HTMLElement} parentEl
 * @param {{ doc: string, placeholder: string, labelId: string, onDocChange: () => void }} options
 */
export function mountListJsonEditor(parentEl, options) {
  const { doc, placeholder: ph, labelId, onDocChange } = options;
  const placeholderConf = new Compartment();

  const attrs = {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'List data as JSON',
  };
  if (labelId) attrs['aria-labelledby'] = labelId;

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged || !onDocChange) return;
    // Match <textarea> behavior: programmatic replaces do not fire "input".
    if (update.transactions.every((tr) => tr.isUserEvent('program'))) return;
    onDocChange();
  });

  const state = EditorState.create({
    doc: doc || '',
    extensions: [
      editorTheme,
      EditorView.contentAttributes.of(attrs),
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      json(),
      placeholderConf.of(placeholder(ph || '')),
      EditorView.lineWrapping,
      updateListener,
    ],
  });

  const view = new EditorView({ state, parent: parentEl });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (text) => {
      const next = text ?? '';
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        userEvent: 'program',
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
