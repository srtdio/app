import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';

// F5 image-pin composer: the sibling of the F4 caption composer, pin-worded. It
// shows the slide the pin landed on (filename or "Slide N") instead of a caption
// quote, and owns no RPC. PostDetailPage passes onSubmit, which mints the comment
// and the image_pin annotation on one trace. Amber accent is the F1 annotation
// token, so the context block flips correctly in light and dark.

interface PinAnnotationComposerProps {
  open: boolean;
  /** The slide the pin is anchored to (filename or "Slide N"). */
  context: string;
  onClose: () => void;
  onSubmit: (body: string) => void | Promise<void>;
  submitting?: boolean;
}

export function PinAnnotationComposer({
  open,
  context,
  onClose,
  onSubmit,
  submitting = false,
}: PinAnnotationComposerProps) {
  const [body, setBody] = useState('');

  // Start each pin comment from an empty field so a prior draft never leaks in.
  useEffect(() => {
    if (open) setBody('');
  }, [open]);

  const canPost = body.trim().length > 0 && !submitting;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Comment on image"
      footer={
        <>
          <Button
            size="lg"
            className="min-h-[44px] min-w-[44px]"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="lg"
            variant="primary"
            className="ml-auto min-h-[44px] min-w-[44px]"
            disabled={!canPost}
            onClick={() => void onSubmit(body)}
          >
            {submitting ? 'Posting' : 'Post'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border-l-4 border-annotation-line bg-annotation-bg px-3 py-2 text-sm text-fg">
          {context}
        </div>
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add your comment"
          aria-label="Image comment body"
          disabled={submitting}
          autoFocus
        />
      </div>
    </Sheet>
  );
}
