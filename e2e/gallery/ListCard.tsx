import { cell, type GalleryCell } from './frame';
import { ListCard, ListCardBox } from '@/components/ui/ListCard';
import { IconBriefs } from '@/components/ui/icons';
import {
  BROKEN_PHOTO,
  LONG_TEXT,
  LONGEST_NAME,
  NAME,
  ONE_LONG_WORD,
  PHOTO,
  SHORT,
} from './fixtures';

export const part = 'ListCard';

const noop = (): undefined => undefined;

const MANY = Array.from({ length: 12 }, (_, i) => i + 1);

export const cells: readonly GalleryCell[] = [
  cell('loading', () => (
    <div className="flex flex-col">
      <ListCardBox />
      <ListCardBox round />
    </div>
  )),
  cell('one', () => (
    <div className="flex flex-col">
      <ListCard
        picture={{ kind: 'person', name: NAME, src: PHOTO }}
        title={NAME}
        time="10:42"
        preview="See you at the shoot"
        onPress={noop}
      />
    </div>
  )),
  cell('some', () => (
    <div className="flex flex-col">
      <ListCard
        picture={{ kind: 'person', name: NAME, src: PHOTO }}
        title={NAME}
        time="10:42"
        preview="See you at the shoot"
        unread
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'icon', icon: IconBriefs }}
        title={SHORT}
        time="Fri"
        preview="Three posts for the spring range"
        tag="Brief"
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'placeholder', placeholder: 'text' }}
        title="Morning teaser"
        time="2d late"
        timeBad
        tag="Review"
        tagDot="review"
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'placeholder', placeholder: 'video' }}
        title="Studio tour reel"
        time="12 Nov"
        tag="Approved"
        tagDot="approved"
        onPress={noop}
      />
    </div>
  )),
  cell('too-many', () => (
    <div className="flex flex-col">
      {MANY.map((n) => (
        <ListCard
          key={n}
          picture={{ kind: 'placeholder', placeholder: 'text' }}
          title={`Post ${n}`}
          time="Today"
          preview="A short caption line"
          tag="Draft"
          tagDot="draft"
          onPress={noop}
        />
      ))}
    </div>
  )),
  cell('default', () => (
    <ListCard
      picture={{ kind: 'person', name: NAME, src: PHOTO }}
      title={NAME}
      time="10:42"
      preview="See you at the shoot"
      onPress={noop}
    />
  )),
  cell('selected', () => (
    <div className="flex flex-col">
      <ListCard
        picture={{ kind: 'person', name: NAME, src: PHOTO }}
        title={NAME}
        time="10:42"
        preview="See you at the shoot"
        selected
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'placeholder', placeholder: 'text' }}
        title="Morning teaser"
        time="Fri"
        tag="Review"
        tagDot="review"
        select={{ active: true, chosen: true, onEnter: noop, onToggle: noop }}
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'placeholder', placeholder: 'video' }}
        title="Studio tour reel"
        time="12 Nov"
        tag="Draft"
        tagDot="draft"
        select={{ active: true, chosen: false, onEnter: noop, onToggle: noop }}
        onPress={noop}
      />
    </div>
  )),
  cell('disabled', () => (
    <ListCard
      picture={{ kind: 'placeholder', placeholder: 'text' }}
      title="Morning teaser"
      time="Fri"
      tag="Approved"
      tagDot="approved"
      disabled
      onPress={noop}
    />
  )),
  cell('long-text', () => (
    <div className="flex flex-col">
      <ListCard
        picture={{ kind: 'icon', icon: IconBriefs }}
        title={LONG_TEXT}
        time="12 Nov"
        preview={LONG_TEXT}
        tag="Review"
        unread
        onPress={noop}
      />
      <ListCard
        picture={{ kind: 'icon', icon: IconBriefs }}
        title={LONG_TEXT}
        time="12 Nov"
        preview={LONG_TEXT}
        previewLines={2}
        unread
        onPress={noop}
      />
    </div>
  )),
  cell('one-long-word', () => (
    <ListCard
      picture={{ kind: 'icon', icon: IconBriefs }}
      title={ONE_LONG_WORD}
      time="12 Nov"
      preview={ONE_LONG_WORD}
      tag={ONE_LONG_WORD}
      onPress={noop}
    />
  )),
  cell('no-text', () => (
    <ListCard picture={{ kind: 'placeholder', placeholder: 'text' }} title="" onPress={noop} />
  )),
  cell('longest-name', () => (
    <ListCard
      picture={{ kind: 'person', name: LONGEST_NAME }}
      title={LONGEST_NAME}
      time="10:42"
      preview="See you at the shoot"
      onPress={noop}
    />
  )),
  cell('missing-picture', () => (
    <ListCard
      picture={{ kind: 'person', name: NAME }}
      title={NAME}
      time="10:42"
      preview="See you at the shoot"
      onPress={noop}
    />
  )),
  cell('failed-picture', () => (
    <ListCard
      picture={{ kind: 'person', name: NAME, src: BROKEN_PHOTO }}
      title={NAME}
      time="10:42"
      preview="See you at the shoot"
      onPress={noop}
    />
  )),
  cell('narrow-320', () => (
    <ListCard
      picture={{ kind: 'person', name: NAME, src: PHOTO }}
      title={NAME}
      time="10:42"
      preview="See you at the shoot"
      tag="Chat"
      unread
      onPress={noop}
    />
  )),
  cell('all-slots-on', () => (
    <ListCard
      picture={{ kind: 'person', name: NAME, src: PHOTO }}
      title={NAME}
      time="2d late"
      timeBad
      preview="See you at the shoot"
      tag="Review"
      tagDot="review"
      unread
      select={{ active: true, chosen: true, onEnter: noop, onToggle: noop }}
      onPress={noop}
    />
  )),
  cell('all-slots-off', () => (
    <ListCard picture={{ kind: 'placeholder', placeholder: 'text' }} title={SHORT} />
  )),
];
