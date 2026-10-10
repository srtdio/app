import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { PageHead } from '@/components/shell/PageHead';
import { IconChevronDown } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

const CATEGORIES = [
  'All topics',
  'Getting started',
  'Briefs',
  'Posts & approvals',
  'Assets',
  'Roles & access',
  'Troubleshooting',
] as const;

type HelpCategory = (typeof CATEGORIES)[number];

interface HelpArticle {
  id: string;
  category: Exclude<HelpCategory, 'All topics'>;
  title: string;
  content: string;
}

const ARTICLES: HelpArticle[] = [
  {
    id: 'sorted-overview',
    category: 'Getting started',
    title: 'What is Sorted for?',
    content:
      'Sorted helps a client and their agency work through social posts together. A client can share a brief, the agency drafts a post, and the post moves through review to an approved, rejected, or parked decision. Sorted does not publish or schedule posts.',
  },
  {
    id: 'first-steps',
    category: 'Getting started',
    title: 'Where should I start?',
    content:
      'Open Pipeline to see posts and their current stages. Agency teammates can create a post from the Create menu, invite teammates in Settings, or open Briefs to create a brief. Clients can share what they need in a brief and review posts when they are ready.',
  },
  {
    id: 'create-brief',
    category: 'Briefs',
    title: 'How do I create a brief?',
    content:
      'Open Briefs and choose the create action. Add the request details so the agency has the context it needs to draft a post. Your brief will appear in Briefs and can be linked to related work.',
  },
  {
    id: 'edit-brief',
    category: 'Briefs',
    title: 'Can I edit a brief after creating it?',
    content:
      'No. Briefs are read-only after they are created. If something needs clarification, add a comment to the brief or discuss it with your team in Chat.',
  },
  {
    id: 'create-post',
    category: 'Posts & approvals',
    title: 'How do I create or update a post?',
    content:
      'Agency teammates can start a post from the Create menu. Add the post details and any relevant assets, then move it to review when it is ready for the client. Changes to a post are kept as versions so the team can follow its history.',
  },
  {
    id: 'post-stages',
    category: 'Posts & approvals',
    title: 'What do the post stages mean?',
    content:
      'Draft means the agency is still working on the post. Review means it is ready for a decision. Approved means the post has been approved; it is not published by Sorted. Parked means the agency is holding it for now. Rejected means it was declined. Parked and rejected posts can return to review.',
  },
  {
    id: 'request-changes',
    category: 'Posts & approvals',
    title: 'How do I request a change instead of approving?',
    content:
      'Leave a comment on the post describing the change you need. The post stays in Review while the team discusses it and updates the draft. Approvals are per post, not bulk actions.',
  },
  {
    id: 'after-approval',
    category: 'Posts & approvals',
    title: 'What happens after a post is approved?',
    content:
      'The post is marked Approved in Sorted. There is no publishing or scheduling step in the app. An approved post can still be moved to Parked or Rejected if the decision changes.',
  },
  {
    id: 'upload-assets',
    category: 'Assets',
    title: 'Where can I find and upload assets?',
    content:
      'Open Assets to browse the workspace library or add a file. You can also reach assets while working on a post or brief. If an upload does not complete, try again; if it keeps failing, share the page and any error message with your team in Chat.',
  },
  {
    id: 'asset-versions',
    category: 'Assets',
    title: 'Why do assets have versions?',
    content:
      'Uploading an updated file creates a new asset version instead of replacing the old one. Existing post and brief attachments stay connected to the specific version they used, so earlier work remains intact.',
  },
  {
    id: 'roles',
    category: 'Roles & access',
    title: 'What can clients and agency teammates see?',
    content:
      'Agency teammates can use the workspace sections available to their role; admin settings are limited to workspace admins. Clients can see posts outside Draft, their own briefs, assets, and Activity events that involve them. Your role determines which actions are available.',
  },
  {
    id: 'missing-content',
    category: 'Troubleshooting',
    title: 'Why can’t I see a post or brief?',
    content:
      'Check that you are in the right workspace using the workspace switcher. Clients cannot see posts while they are in Draft, and clients only see their own briefs. If the item should be visible, ask a workspace admin or your agency team to check your access.',
  },
  {
    id: 'activity-history',
    category: 'Troubleshooting',
    title: 'Where can I find past updates?',
    content:
      'Open Activity for a record of workspace events, including updates involving posts, briefs, and people. For a conversation, open Chat or the comments on the relevant post or brief.',
  },
  {
    id: 'ask-team',
    category: 'Troubleshooting',
    title: 'How can I get help from my team?',
    content:
      'Message your teammates in Chat. For an access or invitation issue, contact a workspace admin. Include the name of the page or item you were using so your team can help faster.',
  },
];

export function filterHelpArticles(
  articles: HelpArticle[],
  category: HelpCategory,
  query: string,
): HelpArticle[] {
  const search = query.trim().toLocaleLowerCase();
  return articles.filter((article) => {
    const matchesCategory = category === 'All topics' || article.category === category;
    const matchesSearch =
      search === '' ||
      `${article.category} ${article.title} ${article.content}`
        .toLocaleLowerCase()
        .includes(search);
    return matchesCategory && matchesSearch;
  });
}

const QUICK_LINKS = [
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/briefs', label: 'Briefs' },
  { to: '/assets', label: 'Assets' },
  { to: '/chat', label: 'Chat with your team' },
];

export function HelpPage() {
  const [category, setCategory] = useState<HelpCategory>('All topics');
  const [query, setQuery] = useState('');
  const articles = useMemo(() => filterHelpArticles(ARTICLES, category, query), [category, query]);

  return (
    <>
      <PageHead title="Help" />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <section className="rounded-2xl border border-border bg-panel-2 p-5 md:p-8">
          <p className="text-sm font-medium text-accent">Sorted Help Center</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
            Find your way through the workflow
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-fg-2">
            Quick answers about pipeline, briefs, posts, approvals, assets, and chat with your team.
          </p>
          <div className="mt-5 max-w-xl">
            <label htmlFor="help-search" className="sr-only">
              Search help articles
            </label>
            <Input
              id="help-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search help articles"
            />
          </div>
          <nav aria-label="Helpful sections" className="mt-5 flex flex-wrap gap-2">
            {QUICK_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className="inline-flex min-h-[44px] items-center rounded-full border border-border bg-panel px-4 text-sm font-medium text-fg-2 transition-colors hover:bg-panel-3 hover:text-fg"
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </section>

        <section className="mt-8" aria-labelledby="help-articles-heading">
          <div className="flex flex-col gap-1">
            <h2 id="help-articles-heading" className="text-lg font-semibold">
              Help articles
            </h2>
            <p className="text-sm text-fg-3">
              {articles.length} {articles.length === 1 ? 'article' : 'articles'}
            </p>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Filter help articles">
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={category === item}
                onClick={() => setCategory(item)}
                className={cn(
                  'min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
                  category === item
                    ? 'border-accent-line bg-accent-soft text-accent'
                    : 'border-border text-fg-2 hover:bg-panel-2',
                )}
              >
                {item}
              </button>
            ))}
          </div>

          {articles.length > 0 ? (
            <div className="mt-2 space-y-2">
              {articles.map((article) => (
                <details
                  key={article.id}
                  className="group rounded-xl border border-border bg-panel px-4"
                >
                  <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 text-left text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
                    <span>{article.title}</span>
                    <IconChevronDown
                      size={18}
                      className="shrink-0 text-fg-3 transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <p className="max-w-3xl pb-4 pr-8 text-sm leading-6 text-fg-2">
                    {article.content}
                  </p>
                </details>
              ))}
            </div>
          ) : (
            <div className="mt-2 rounded-xl border border-border bg-panel px-4 py-8 text-center">
              <p className="text-sm font-medium">No matching articles</p>
              <p className="mt-1 text-sm text-fg-3">
                Try another search or choose a different topic.
              </p>
            </div>
          )}
        </section>
      </div>
      <div className="mb-10 text-center text-md">
        For any queries or support, please contact our team at{' '}
        <a
          href="mailto:support@srtd.io"
          className="text-accent underline underline-offset-2 transition-colors hover:text-accent/80"
        >
          support@srtd.io
        </a>
      </div>
    </>
  );
}
