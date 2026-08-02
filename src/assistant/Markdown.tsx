/**
 * Editorial markdown for assistant replies: serif body via design tokens,
 * quiet chrome for code/quotes/tables. GFM for lists and tables.
 */
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cx, tone, type_ } from '../ui'

const BODY = cx(type_.body, tone.textPrimary)

const components: Components = {
  p: ({ children }) => <p className={cx(BODY, 'mb-2 last:mb-0')}>{children}</p>,
  ul: ({ children }) => (
    <ul className={cx(BODY, 'mb-2 list-disc pl-5 last:mb-0')}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className={cx(BODY, 'mb-2 list-decimal pl-5 last:mb-0')}>{children}</ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => (
    <h3 className={cx(type_.heading, tone.textPrimary, 'mb-1.5 mt-3 first:mt-0')}>{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className={cx(type_.heading, tone.textPrimary, 'mb-1.5 mt-3 first:mt-0')}>{children}</h3>
  ),
  h3: ({ children }) => (
    <h3 className={cx(type_.heading, tone.textPrimary, 'mb-1.5 mt-3 first:mt-0')}>{children}</h3>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx(tone.accent, 'underline [overflow-wrap:anywhere]')}
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className={cx('mb-2 border-l-2 pl-3 italic', tone.border, tone.textSecondary)}>
      {children}
    </blockquote>
  ),
  code: ({ children, className }) =>
    className ? (
      // Block code (inside <pre>): language class present.
      <code className={cx('font-mono text-[12.5px] leading-relaxed', className)}>{children}</code>
    ) : (
      <code className={cx('rounded px-1 py-0.5 font-mono text-[13px]', tone.sunken)}>
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre
      className={cx(
        'mb-2 overflow-x-auto rounded-xl p-3 [overflow-wrap:normal] last:mb-0',
        tone.sunken,
      )}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className={cx(type_.sub, tone.textPrimary, 'w-full border-collapse')}>
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className={cx('border-b py-1 pr-3 text-left font-semibold', tone.borderStrong)}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className={cx('border-b py-1 pr-3 align-top', tone.border)}>{children}</td>
  ),
  hr: () => <hr className={cx('my-3 border-t', tone.border)} />,
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
