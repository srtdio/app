// Static English keywords for every emoji in the curated list (emoji-list.ts),
// so the emoji sheet can search by word with no emoji package and no network.
// Each value is space-separated lowercase words: the CLDR short name first
// (its first word names the glyph for a screen reader), then common synonyms.
// A guard test keeps every emoji in every group covered.

/** emoji -> space-separated lowercase keywords. */
export const EMOJI_NAMES: Readonly<Record<string, string>> = {
  // Smileys
  '😀': 'grinning face smile happy',
  '😃': 'grinning face big eyes smile happy',
  '😄': 'grinning face smiling eyes smile happy laugh',
  '😁': 'beaming face smiling eyes grin teeth happy',
  '😆': 'grinning squinting face laugh lol happy',
  '😅': 'grinning face sweat relief phew nervous laugh',
  '😂': 'joy face tears laugh lol crying funny',
  '🤣': 'rofl rolling floor laughing lol funny',
  '😊': 'smiling face blush happy pleased',
  '😇': 'halo smiling face angel innocent',
  '🙂': 'slightly smiling face smile',
  '🙃': 'upside down face silly sarcasm',
  '😉': 'winking face wink',
  '😌': 'relieved face calm content',
  '😍': 'heart eyes smiling face love crush',
  '🥰': 'smiling face hearts love adore',
  '😘': 'kiss face blowing love',
  '😗': 'kissing face kiss',
  '😋': 'yum face savoring food delicious tasty',
  '😛': 'tongue face playful',
  '😜': 'winking face tongue crazy playful joke',
  '🤪': 'zany face crazy goofy wild',
  '😝': 'squinting face tongue playful',
  '🤗': 'hugging face hug open hands',
  '🤭': 'giggle face hand over mouth oops',
  '🤫': 'shushing face quiet secret shh',
  '🤔': 'thinking face hmm think wonder',
  '🤐': 'zipper mouth face quiet secret',
  '🤨': 'raised eyebrow face skeptical suspicious',
  '😐': 'neutral face meh blank',
  '😑': 'expressionless face blank meh',
  '😶': 'no mouth face speechless silent',
  '😏': 'smirking face smirk sly',
  '😒': 'unamused face annoyed meh',
  '🙄': 'eye roll face rolling eyes whatever',
  '😬': 'grimacing face awkward yikes',
  '😮‍💨': 'exhaling face sigh relief phew',
  '😴': 'sleeping face sleep tired zzz',
  '😷': 'mask face medical sick ill',
  '🤒': 'thermometer face sick ill fever',
  '🤯': 'exploding head mind blown shocked',
  '🥳': 'partying face party celebrate birthday',
  '😎': 'sunglasses smiling face cool',
  '🤓': 'nerd face geek glasses',
  '🧐': 'monocle face curious inspect',
  '😕': 'confused face unsure',
  '😟': 'worried face concerned anxious',
  '🙁': 'slightly frowning face sad',
  '😮': 'open mouth face surprised wow',
  '😲': 'astonished face shocked surprised wow',
  '😳': 'flushed face embarrassed blush',
  '🥺': 'pleading face puppy eyes please',
  '😢': 'crying face sad tear',
  '😭': 'loudly crying face sob sad tears',
  '😱': 'screaming face fear scared shocked',
  '😖': 'confounded face frustrated',
  '😤': 'steam face nose triumph frustrated huff',
  '😡': 'enraged face angry mad pouting',
  '🤬': 'cursing face symbols mouth angry swear',
  '😈': 'devil smiling face horns evil',
  // Gestures
  '👍': 'thumbs up yes like approve good ok',
  '👎': 'thumbs down no dislike bad',
  '👌': 'ok hand perfect fine',
  '🤌': 'pinched fingers italian',
  '✌️': 'victory hand peace',
  '🤞': 'crossed fingers luck hope',
  '🤟': 'love you gesture hand',
  '🤘': 'horns sign rock metal',
  '🤙': 'call me hand shaka',
  '👈': 'point left backhand index finger',
  '👉': 'point right backhand index finger',
  '👆': 'point up backhand index finger',
  '👇': 'point down backhand index finger',
  '☝️': 'index pointing up finger one',
  '👋': 'waving hand wave hello hi bye',
  '🤚': 'raised back hand stop',
  '✋': 'raised hand stop high five',
  '🖐️': 'hand fingers splayed five',
  '🖖': 'vulcan salute spock',
  '👏': 'clapping hands clap applause bravo',
  '🙌': 'raising hands celebrate hooray praise',
  '👐': 'open hands',
  '🤲': 'palms up together',
  '🤝': 'handshake deal agreement',
  '🙏': 'folded hands please pray thanks',
  '✍️': 'writing hand write sign',
  '💪': 'flexed biceps strong muscle',
  '🫶': 'heart hands love',
  '👀': 'eyes look see watching',
  '🧠': 'brain smart think',
  // Hearts
  '❤️': 'red heart love like',
  '🧡': 'orange heart love',
  '💛': 'yellow heart love',
  '💚': 'green heart love',
  '💙': 'blue heart love',
  '💜': 'purple heart love',
  '🖤': 'black heart love',
  '🤍': 'white heart love',
  '🤎': 'brown heart love',
  '💔': 'broken heart sad heartbreak',
  '❤️‍🔥': 'heart on fire love passion burning',
  '💕': 'two hearts love',
  '💞': 'revolving hearts love',
  '💓': 'beating heart love',
  '💗': 'growing heart love',
  '💖': 'sparkling heart love',
  '💘': 'heart arrow cupid love',
  '💝': 'heart ribbon gift love',
  '💯': 'hundred points perfect score full',
  '💢': 'anger symbol angry mad',
  '💥': 'collision boom bang explosion',
  '💫': 'dizzy star',
  '💦': 'sweat droplets water splash',
  '💬': 'speech balloon chat comment message bubble',
  '✨': 'sparkles shiny magic new',
  '⭐': 'star favourite favorite',
  '🌟': 'glowing star shine',
  '🔥': 'fire flame hot lit',
  '⚡': 'high voltage lightning zap electric fast',
  '🎉': 'party popper tada celebrate congrats',
  // Work
  '✅': 'check mark button done yes tick complete',
  '☑️': 'check box ballot done tick',
  '✔️': 'check mark done yes tick',
  '❌': 'cross mark no wrong cancel',
  '❎': 'cross mark button no',
  '⚠️': 'warning caution alert',
  '❗': 'exclamation mark red important alert',
  '❓': 'question mark red help',
  '⏰': 'alarm clock time reminder',
  '⏳': 'hourglass time waiting pending',
  '📅': 'calendar date schedule',
  '📆': 'tear off calendar date schedule',
  '🗓️': 'spiral calendar date schedule plan',
  '📌': 'pushpin pin',
  '📍': 'round pushpin pin location',
  '📎': 'paperclip attach attachment',
  '🖇️': 'linked paperclips attach',
  '📝': 'memo note write draft',
  '✏️': 'pencil write edit draft',
  '🖊️': 'pen write sign',
  '📁': 'file folder',
  '📂': 'open file folder',
  '🗂️': 'card index dividers folder organize',
  '📊': 'bar chart stats graph report',
  '📈': 'chart increasing growth up trend stats',
  '📉': 'chart decreasing down trend stats',
  '📋': 'clipboard list copy',
  '📣': 'megaphone announce cheer',
  '📢': 'loudspeaker announce public',
  '🔔': 'bell notification alert ring',
  '🔕': 'bell slash mute silent',
  '💡': 'light bulb idea',
  '🔍': 'magnifying glass search find zoom',
  '🔗': 'link chain url',
  '🔒': 'locked lock private secure',
  '🔓': 'unlocked open lock',
  '🏷️': 'label tag price',
  '💼': 'briefcase work business job',
  '🧾': 'receipt invoice bill',
  '💰': 'money bag cash dollar budget',
  // Media
  '📷': 'camera photo picture',
  '📸': 'camera flash photo picture',
  '📹': 'video camera record',
  '🎥': 'movie camera film video',
  '🎬': 'clapper board film movie action',
  '🎞️': 'film frames movie',
  '📺': 'television tv',
  '📱': 'mobile phone smartphone cell',
  '💻': 'laptop computer',
  '🖥️': 'desktop computer screen monitor',
  '⌨️': 'keyboard type',
  '🖱️': 'computer mouse click',
  '🎨': 'artist palette art paint design',
  '🖌️': 'paintbrush paint art design',
  '🖼️': 'framed picture image photo art',
  '🎵': 'musical note music song',
  '🎶': 'musical notes music song',
  '🎤': 'microphone mic sing karaoke',
  '🎧': 'headphone headphones music listen',
  '🎙️': 'studio microphone mic podcast',
  '📰': 'newspaper news press',
  '🗞️': 'rolled up newspaper news press',
  '📖': 'open book read',
  '📚': 'books read library study',
  '🔖': 'bookmark save',
  '✉️': 'envelope mail letter email',
  '📧': 'email mail letter',
  '📨': 'incoming envelope mail email',
  '📩': 'envelope arrow mail email send',
  '📤': 'outbox tray send mail',
  // Things
  '☕': 'hot beverage coffee tea drink',
  '🍵': 'teacup tea green drink',
  '🍕': 'pizza food slice',
  '🍔': 'hamburger burger food',
  '🍟': 'french fries chips food',
  '🌮': 'taco food mexican',
  '🍰': 'shortcake cake dessert',
  '🎂': 'birthday cake celebrate party',
  '🍪': 'cookie biscuit dessert',
  '🍫': 'chocolate bar sweet',
  '🍿': 'popcorn movie snack',
  '🥂': 'clinking glasses cheers toast celebrate champagne',
  '🍻': 'clinking beer mugs cheers drinks',
  '🍾': 'bottle popping cork champagne celebrate',
  '🎁': 'wrapped gift present birthday',
  '🎈': 'balloon party birthday',
  '🏆': 'trophy win winner award champion',
  '🥇': 'first place medal gold winner',
  '🚀': 'rocket launch ship fast',
  '✈️': 'airplane plane travel flight',
  '🚗': 'automobile car drive',
  '🏠': 'house home',
  '🌍': 'globe earth world europe africa',
  '☀️': 'sun sunny weather',
  '🌙': 'crescent moon night',
  '🌈': 'rainbow pride',
  '☔': 'umbrella rain weather',
  '❄️': 'snowflake snow cold winter',
  '🌸': 'cherry blossom flower spring',
  '🌻': 'sunflower flower summer',
};

/** A group of the curated list (only the glyphs are read). */
interface SearchGroup {
  emoji: readonly string[];
}

/** The words a glyph is found by; empty when it has no entry. Pure. */
export function emojiKeywords(emoji: string): string[] {
  const raw = EMOJI_NAMES[emoji];
  return raw === undefined ? [] : raw.split(' ').filter((w) => w !== '');
}

/** The first keyword (a screen reader's name for the glyph), else the glyph itself. Pure. */
export function emojiLabel(emoji: string): string {
  return emojiKeywords(emoji)[0] ?? emoji;
}

/**
 * The glyphs whose keywords match the query, in group order, no repeats.
 * Case-insensitive; every typed word must be the start of some keyword (so
 * "fi" finds fire, "red heart" finds the red heart). Empty query: []. Pure.
 */
export function searchEmoji(query: string, groups: readonly SearchGroup[]): string[] {
  const words = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const emoji of group.emoji) {
      if (seen.has(emoji)) continue;
      const keywords = emojiKeywords(emoji);
      if (words.every((w) => keywords.some((k) => k.startsWith(w)))) {
        seen.add(emoji);
        out.push(emoji);
      }
    }
  }
  return out;
}
