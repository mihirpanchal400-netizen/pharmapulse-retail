import { Hammer } from 'lucide-react';
import { Card, PageHeader } from '../components/ui';

/**
 * Honest placeholder for screens that are not built yet.
 *
 * The route exists so navigation never dead-ends or throws, and the page states
 * plainly what is missing and what already works underneath it — rather than
 * showing an empty shell that looks like a bug.
 */
export default function ComingSoon({
  title,
  subtitle,
  apiNote,
}: {
  title: string;
  subtitle?: string;
  apiNote?: string;
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <Card>
        <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-amber-50 text-amber-600">
            <Hammer className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-sm font-medium text-slate-800">This screen is not built yet</p>
          <p className="max-w-md text-sm leading-relaxed text-slate-500">
            {apiNote ??
              'The API endpoints behind this screen are complete and tested — only the interface is outstanding.'}
          </p>
        </div>
      </Card>
    </>
  );
}
