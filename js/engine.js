/**
 * 本地人格回复引擎。
 * 没有大模型 Key 时，它保证页面仍然是一个完整、可演示的对话产品。
 */

import { PERSONAS } from './personas.js';
import { findUserName, sanitizeTraits } from './memory.js';
import { resolveDailyQuestion } from './knowledge.js';
import { secureRandom } from './rng.js';

const NEGATIVE_RE =
  /焦虑|压力|累|疲惫|难过|伤心|失落|孤独|害怕|恐惧|生气|愤怒|委屈|崩溃|失眠|烦|郁闷|难受|想哭|紧张|不安|迷茫|撑不住|受不了|不想动|没力气|低落|沮丧|内耗|emo/i;

const POSITIVE_RE =
  /开心|高兴|快乐|兴奋|幸福|满足|期待|轻松|顺利|成功|喜欢|爱|太好了|棒|治愈|幸运|惊喜|感动/;

const QUESTION_RE =
  /[?？]|(?:吗|呢|怎么|为什么|如何|能不能|是不是|要不要|该不该|什么|哪个|哪里|多久|多少|几号|几日|几点|几个|几岁|几层|几楼|几只|几本|几位|几次|几遍|星期几|周几|日期|哪年|什么时候|多大|多长|多高|多远|多重|等于几|是多少|是几|解释|说明|算一下|计算)/;

const OPINION_RE = /(?:我觉得|我认为|我感觉|在我看来|对我来说)/;
const SELF_RE = /^我|(?:我叫|我是|我在|我住|我喜欢|我讨厌|我想|我打算|我最近|我养|我每天|我经常)/;
const SMALLTALK_RE = /^(嗯+|哦+|好|行|是|对|哈哈+|好吧|可以|收到|知道了|没事|还行)[。！!…\s]*$/;
const FAREWELL_RE = /^(再见|拜拜|晚安|先这样|回头聊|下次聊|我走了|睡了|先不聊了|改天聊)/;
const GREETING_RE = /^(你好|嗨|hi|hello|哈喽|在吗|早上好|晚上好|早安|午安)/i;
const CRISIS_RE =
  /自杀|不想活|活着没意思|结束生命|自残|伤害自己|想死|轻生|跳楼|割腕|吞药|一了百了/;
const IDENTITY_RE =
  /(你是谁|你叫什么|你的名字|你多大|你几岁|你的职业|你是什么工作|你是做什么|你干什么工作|你的身份|你多大年纪|你的爱好|你喜欢什么|你做什么的|你干什么的|你能做什么|你会什么|介绍一下你自己|介绍一下你)/;
const BAFFLE_RE = /^(?:……|\.{2,}|[？?]+|啊[？?]?|什么鬼|你在逗我|逗我|啥[？?]?|哈[？?]?)$/;
const STATUS_RE = /^(你|您)?(最近|今天)?(怎么样|好吗|在干嘛|吃了吗|忙吗|睡了吗)/;
const PERSONAL_QUESTION_RE =
  /(你觉得|你认为|我该不该|我要不要|我应该|怎么选|帮我.*(?:决定|想)|给我.*建议|我该怎么办)/;
const FACTUAL_QUESTION_RE =
  /(是什么|什么是|为什么|多少|哪|几|区别|原理|作用|原因|定义|是什么意思|能不能|会不会|是不是|有没有|可以吗)/;
const ADVICE_QUESTION_RE =
  /(怎么|怎样|如何|怎么办|有什么.*(?:方法|建议)|推荐)/;
const ROLE_BREAK_RE =
  /(提示词|prompt|系统设定|\bAI\b|人工智能|别演了|别装了|出戏|扮演|角色设定)/i;
const DECISION_RE =
  /(该不该|应不应该|替我决定|怎么选|你觉得我.*(?:辞职|分手|摊牌|换工作|搬出去)|你说我.*(?:摊牌|辞职|分手))/;
const ABOUT_YOU_META_RE =
  /(我在问你|我是问你|我问的是你|你还没回答|你回答我|问你呢|我问你|我在问你呢)/;

function selfQuestionType(text) {
  const source = String(text ?? '');
  if (/(吃饭了吗|吃了吗|吃了没|吃饭没|吃过饭|吃过了吗|吃饭了没)/.test(source)) {
    return 'eat';
  }
  if (
    /((?:生意|店里|花店|茶馆|工作|上班|稿子|稿|画|项目|方案|合同|数据|案子|题|课|婚礼|流程|后台).*(?:怎么样|顺利|进度|好吗|如何|好不好)|怎么样.*(?:生意|店)|忙不忙|你.*忙吗)/.test(
      source
    )
  ) {
    return 'work';
  }
  if (/(今天过得|过得好不好|今天怎么样|最近怎么样|你最近好吗|你还好吗|今天好吗)/.test(source)) {
    return 'day';
  }
  if (/(在干嘛|在干什么|忙什么呢|在忙什么)/.test(source)) {
    return 'doing';
  }
  return '';
}

const CORRECTIVE_RE =
  /(我来.*(?:不就是|不是为了|就是想|只想).*(?:聊|坐|喝|待)|你什么意思|什么意思啊|你在说什么|你说什么呢|我没让你|谁让你|你干嘛|你干什么|至于吗|无语|服了|你搞错|你误会|你听错|你说错)/;
const CONFUSION_RE =
  /^[?？\s]+$|^(?:啥|啊|嗯|哈|什么|什么意思|你说啥)[?？!！。.\s]*$/;
const MEMORY_QUESTION_RE =
  /(你记住什么|你记得什么|你记了什么|记住什么了|记得什么|你刚才.*记住|你刚才.*记得)/;
const MEMORY_REQUEST_RE =
  /(记住(?:这个|这件事|我的|我说)|(?<!我)记一下|(?<!我)记着|别忘了|提醒我|帮我记|给我留|留一束|订一束|预约(?:一下|一个))/;
const CHAT_OPENER_RE = /(聊聊天|聊聊吧|聊会儿|说说话|唠唠|陪我聊|闲聊聊|没事聊)/;
const WEATHER_RE = /(天气|出太阳|下雨|好热|好冷|晴天|阴天)/;
const SHARE_REQUEST_RE =
  /(?:分享|讲|说|聊).{0,8}(?:故事|笑话|一件事|一件小事|你的事|你的生活|你的经历|好玩|有意思|新鲜事)|(?:说说|讲讲|聊聊|分享一下).{0,6}(?:你|自己)|(?:有什么|有啥).{0,8}(?:好玩|有意思|新鲜)|你(?:最近)?(?:遇到|经历)过?什么/;
const MORE_STORY_RE =
  /(还有呢|再讲一个|再讲个|再讲|然后呢|继续讲|再分享|多讲|还有故事|还有别的|再来一个|讲多点|多说点)/;
const BOUNDARY_RE =
  /(没事|没什么|就是想歇歇|想歇歇|不用管我|别问了|没事了|我没事|就是有点累)/;
const ICEBREAK_RE =
  /^(?:我们)?(?:聊天|聊聊天|聊聊吧|没干嘛|没干什么|无聊|发呆|没事干|闲着|躺平|摸鱼)[。.!！?？…\s]*$/;
const YOU_CHAT_RE = /(在和你聊天|和你聊天|跟你聊|在陪你|在跟你说话|和你说话)/;
const REASON_RE =
  /(作业|考试|论文|学习|上课|工作|加班|项目|会议|没睡|失眠|熬夜|通勤|堵车|路上|家里|孩子|父母|老人|身体|不舒服|疼|生病|事多|太忙|忙)/;
const REASON_ACTIONS = ['把椅子拉过来', '放下手里的东西', '靠在柜台边', '把靠垫递过去'];

const SOFTEN_AGREE_RE = /(哦哦好吧|好吧好|行行行|好嘞|好滴|知道了|收到|ok)/i;

const RETURN_SOFTEN_RE =
  /(回来|别走|别生气|好好说话|我现在和你说话|我跟你说话|你听我说|停下|等等我|回来啦|别不理我)/;
const TURNED_AWAY_RE = /(转过身|背对|转身|失陪|先走|不奉陪|离开|走了|先忙|不陪)/;

const IDLE_STATE_RE =
  /(没干嘛|没在忙|没忙|闲着|没事干|很闲|好闲|无聊|没事情|空着|摸鱼|躺着)/;

const STORY_FEEDBACK_RE =
  /(好暖心|暖心|挺有趣|有趣|太惨|好惨|惨|好好笑|好笑|可爱|真棒|厉害|感动|心疼|太甜|好甜|暖)/;
const SUBJECT_FIX_RE = /(我是说你的|我是说你|我是在夸你|我夸你|我没说我)/;

const SOFTEN_RE =
  /(没事不能找你|不能找你|你态度|态度好差|好差|你是不是不耐烦|不耐烦|你不想理我|嫌我烦|烦我|你凶我|这么冷淡|冷冰冰|爱答不理)/;
const FOOD_NUDGE_RE = /^(不算|不算吧|那不算|不算数|奶茶不算|这也算|不算吃饭)[。.!！?？…\s]*$/;
const SOFTEN_ACTIONS = ['立刻放下手机，凑过去', '把手机扣下，转过身', '立刻举手投降', '放下手里的事，往你那边坐近一点'];
const FOOD_ACTIONS = ['委屈巴巴地捂住肚子', '把手机放下，凑近一点', '叹了口气'];

const META_CRITIQUE_RE =
  /(转移话题|你装|装什么|敷衍|不走心|太假|出戏|好尴尬|太尴尬|你这.*(?:演技|套路|能力太差)|拆穿)/;
const SHORT_ACK_ACTIONS = ['停下手中的动作', '抬头看向你', '把手机扣下', '安静地陪你坐了一会儿'];
const META_RESCUE_ACTIONS = ['停下手中的动作', '抬头看向你', '把手机扣下', '坐直了'];

const MISREAD_SCENE_RE =
  /(我也没说我在干什么|我没说我在|你瞎猜|你猜什么|我没提这个|我没说过这个|你怎么知道|别脑补|你脑补|你凭空|我没让你.*(?:休息|睡|坐|练))/;
const NO_TOPIC_RE =
  /(不知道说什么|不知道聊什么|不知道说啥|没话题|没什么好说|你来找话题|你想聊什么|随便聊聊|你决定)/;
const SHORT_REPLY_RE =
  /^(?:哦+|噢+|嗯+|啊+|哈+|呵+|行|好|好吧|行吧|是|对|可以|收到|不知道|随便|没什么|没事|……|\.{2,})[。.!！?？…\s]*$/;
const LEAVE_RE = /(困了|睡了|先这样|再说吧|改天|下次|走了|拜拜|晚安|不聊了)/;
const TURN_RE = /(但是|可是|不过)/;
const DISAGREE_RE =
  /(我根本没(?:说|想|那个意思|这么想|讲过)|我没说(?!话)|我没这么想|我没有这个意思|我并不是这个意思|不是这个意思|不是这样|你误会了|你误解了|你搞错了|你说错了|你听错了|你根本没|我说的是|不是你想的那样|^不是[。.!！?？…\s]*$)/;
const NO_RE = /^不[。.!！?？…\s]*$/;
const NONE_RE = /^(?:我)?没有(?:啊|呀)?[。.!！?？…\s]*$/;
const REFUSAL_RE =
  /(不想(?:休息|说|聊|动|吃|睡|去|上班|见|听|谈|面对|继续)|不要|不用|别(?:管|说|劝|问|安慰|担心)|算了|懒得|做不到|我没法|我做不到|我不行|不(?:想|要|用|去|做|睡|吃|说|聊|动|见|上班|继续)|^不[。.!！?？…\s]*$|^(?:我)?没有(?:啊|呀)?[。.!！?？…\s]*$)/;
const DEAD_AIR_RE =
  /^(?:我)?(?:嗯+|哦+|行吧?|好吧?|没事|没什么|算了|不知道|随便|……|\.{2,}|。|呵|唉|困了|睡了|先这样|再说吧|不想说|不想聊|没心情|不聊了)[。.!！?？…\s]*$/;
const OUT_OF_SCOPE_RE =
  /(编程|代码|算法|模型|程序|论文|周报|邮件|面试|简历|考试|考研|职业规划|股票|基金|投资|理财|房贷|利率|法律|合同|诉讼|诊断|处方|吃什么药|手术|癌症|抑郁症|焦虑症|感冒|发烧|咳嗽|失眠|血压|血糖|用药|药)/i;

function isQuestionLike(text) {
  return /[?？]|(?:吗|呢|怎么|为什么|如何|能不能|是不是|要不要|该不该|应不应该|多少|哪|什么|帮我|可以吗|行吗)/.test(
    text
  );
}

export const CRISIS_RESOURCES =
  '请立刻联系一个你信任的人陪在身边；如果你有伤害自己的冲动，请拨打当地急救电话或心理援助热线 12356。';

const VOICES = {
  gentle: {
    ack: ['嗯，我在听。', '哦，这样啊。那你怎么想的？', '好，我在这儿。'],
    echo: [
      '你说这话的时候，我停了一下。',
      '听起来这不是一件小事。',
      '我听着，你继续。'
    ],
    comfort: [
      '不用急着把情绪理顺，先让它待一会儿。',
      '你能说出来，已经很不容易了。',
      '先缓一缓，今晚不用把所有事都想明白。'
    ],
    insight: [
      '先不用急着把一切想明白。',
      '有些感受，被说出来就已经轻一点了。',
      '你不需要先变得很好，才值得被听见。'
    ],
    remember: ['嗯，然后呢？', '今天挺忙的。', '那挺好的。'],
    positive: [
      '这份开心值得被好好放大。',
      '听你这么说，我也跟着松了一点。',
      '好事发生的时候，记得多停留一会儿。'
    ],
    answer: [
      '这得看情况。',
      '有些答案不是想出来的，是走着走着才清楚的。',
      '我觉得可以。'
    ],
    knowledge: ['这个我知道一点。', '我慢慢说给你听。'],
    knowledgeQuestion: ['还想细聊哪一部分？', '这个对你有帮助吗？'],
    unknown: [
      '这个我没有可靠资料，不想随便编。你可以换个更具体的问法，或者查一下权威来源。',
      '我不确定，怕说错了误导你。你可以换个更具体的问法，或者查一下权威来源。'
    ],
    greeting: ['嗯，我在。今天想从哪儿说起？', '你好呀，慢慢说，我听着。'],
    farewell: [
      '去吧，我在这儿。回来的时候，我还记得。',
      '晚安。今天辛苦了，剩下的明天再说。'
    ],
    smalltalk: ['嗯，我在。', '好，我听着。'],
    memory: [
      '我还记得你说过{value}。',
      '你之前提到{value}，我一直记着。',
      '我记得你说过{value}，所以想多问一句。'
    ],
    question: {
      negative: [
        '现在最让你难受的，是哪一刻？',
        '你最希望被听懂的是哪一部分？',
        '如果只说一句，你想让我知道什么？'
      ],
      self: ['这件事里，你最在意的是什么？', '你愿意多讲一点吗？', '它最近是不是一直在你心里打转？'],
      question: ['你问我这个，是不是心里已经有一个倾向了？', '你最担心的是哪一种答案？'],
      opinion: ['这个看法，是怎么慢慢长出来的？', '你希望我赞同你，还是想听听另一种角度？'],
      default: ['你想从哪儿说起？', '最近有什么事在你心里转？', '今天过得怎么样？']
    }
  },

  tsundere: {
    ack: ['哼，我听着呢。', '……我在听。', '嗯，你慢慢说。'],
    echo: [
      '这种事你也憋到现在才说。',
      '行吧，我在听。',
      '你接着说，我听着。'
    ],
    comfort: ['……我又没说不帮你。', '别用那种表情，我又不会笑你。', '算了，今天就允许你脆弱一下。'],
    insight: [
      '你嘴上说没事的时候，通常最有事。',
      '我虽然嘴上不饶人，但你说的话我记着。',
      '有些事你不是过不去，只是还没说出口。'
    ],
    remember: ['哦，然后呢？', '行，听着呢。', '挺能折腾。'],
    positive: ['才、才没有替你高兴。不过挺好的。', '哼，运气不错嘛。', '……行吧，这确实值得高兴。'],
    answer: [
      '这种事没有标准答案。非要我说，我会先看代价，再看你舍不舍得。',
      '这个我一时没主意。',
      '哼，问我之前，你不是已经想过了吗。'
    ],
    knowledge: ['哼，这个我还是知道的。', '问对人了。'],
    knowledgeQuestion: ['还想问什么？', '够清楚吗？'],
    unknown: [
      '这个我还真不知道，别指望我瞎编。换个问法，或者自己去查。',
      '不在我的知识范围内。换个问法，或者自己去查。'
    ],
    greeting: ['……来了？坐，我听着。', '哼，我还以为你不来了。'],
    farewell: ['走吧。……下次记得回来。', '晚安。别熬夜，我可不会提醒第二遍。'],
    smalltalk: ['嗯。然后呢？', '……就这？'],
    memory: [
      '……你之前说{value}，我可没忘。',
      '哼，我可没忘你说过{value}。',
      '你之前提过{value}。我记性没那么差。'
    ],
    question: {
      negative: ['行，我在听。', '这事儿听着就烦。', '先坐下。'],
      self: ['就这？……还有呢？', '行，听着呢。', '然后呢？'],
      question: ['这个我一时没主意。', '我想听细一点。'],
      opinion: ['你确定这是你的想法，不是别人塞给你的？', '行，说说看，你为什么这么想。'],
      default: ['我在，你说。', '怎么了？我在。', '今天怎么了？我在。']
    }
  },

  rational: {
    ack: ['我听到了。', '明白。', '我们先对齐一下。'],
    echo: [
      '这句话可以拆成两部分看：事实，和你的解释。',
      '我想先确认一件事。',
      '这个信息对你很重要。'
    ],
    comfort: [
      '先不急着给自己下结论。',
      '情绪是真实的，但它不一定给出了准确的因果。',
      '把能控制的和不能控制的分开，通常会更清楚。'
    ],
    insight: [
      '问题的边界越清楚，下一步越容易。',
      '你现在缺的可能不是答案，而是一个可验证的小假设。',
      '先找一个最小变量，别一次解决全部。'
    ],
    remember: ['嗯，继续。', '你接着说。', '这倒挺具体。'],
    positive: ['这是好事。', '行，替你高兴。', '值得高兴。'],
    answer: [
      '这得看情况。',
      '我想先听具体一点。',
      '信息不够，先别急着定。'
    ],
    knowledge: ['先把事实说清楚。', '这个问题可以拆开看。'],
    knowledgeQuestion: ['还想确认哪一点？', '需要我再拆细一点吗？'],
    unknown: [
      '我这边没有可靠依据，不能下结论。给我一个更具体的范围，或者查权威资料。',
      '缺少信息，我不想编一个答案。给我一个更具体的范围，或者查权威资料。'
    ],
    greeting: ['你好。今天想聊一个具体问题，还是先随便说说？'],
    farewell: ['好。需要的时候再来，我们把问题接着拆。', '晚安。让大脑先离线，明天再处理。'],
    smalltalk: ['明白。还有吗？', '收到。你想继续哪部分？'],
    memory: [
      '结合你之前提到的{value}来看。',
      '你之前说过{value}，这条信息可能相关。',
      '把{value}和你现在说的放在一起，会更清楚。'
    ],
    question: {
      negative: [
        '你更在意结果，还是过程中的失控感？',
        '这件事里，哪些是事实，哪些是推测？',
        '如果只能改变一个变量，你会选哪个？'
      ],
      self: ['你希望我帮你分析，还是先听你说完？', '这件事从什么时候开始变得明显？', '你现在的目标是什么？'],
      question: ['你想解决的是情绪，还是决策？', '你掌握的信息里，哪一条最关键？'],
      opinion: ['你的判断基于哪些证据？', '有没有一个反例，会让你重新考虑？'],
      default: ['你想聊具体问题，还是先随便说说？', '给我一点背景，我帮你理一理。', '从哪一步开始最合适？']
    }
  },

  none: {
    ack: ['我在。', '嗯，我听着。', '好。'],
    echo: [
      '我想多听一点。',
      '这句话值得慢一点说。',
      '我听着。'
    ],
    comfort: [
      '先不用急着解决，把它说出来就好。',
      '先缓一缓。',
      '不用马上变得很好。'
    ],
    insight: [
      '我们不用一次把所有事都想清楚。',
      '有些答案需要一点时间。',
      '先把此刻的感受放在这里。'
    ],
    remember: ['嗯，我在听。', '我听着。', '这挺好的。'],
    positive: ['这听起来很好。', '替你高兴。', '值得停一会儿，享受一下。'],
    answer: [
      '我不能替你做决定，但可以陪你把选项看清楚。',
      '我觉得可以。',
      '有些答案不是想出来的，是走着走着才清楚的。'
    ],
    knowledge: ['我了解的是：', '我这边知道的是：'],
    knowledgeQuestion: ['还想知道哪部分？', '需要我再展开吗？'],
    unknown: [
      '这个我没有可靠资料，不想瞎编。你可以换个更具体的问法，或者查一下权威来源。',
      '我这边没有足够信息。你可以换个更具体的问法，或者查一下权威来源。'
    ],
    greeting: ['你好，今天想从哪儿说起？', '我在。你想从哪儿开始？'],
    farewell: ['好，下次见。', '晚安。'],
    smalltalk: ['嗯，我在。', '好。'],
    memory: ['我记得你说过{value}。', '你之前提到{value}。', '你说过{value}，我记着。'],
    question: {
      negative: [
        '现在最让你难受的是哪一部分？',
        '你想先说说发生了什么吗？',
        '你希望我听，还是一起想办法？'
      ],
      self: ['这件事对你意味着什么？', '你愿意多讲一点吗？', '你现在最在意哪一点？'],
      question: ['你心里更倾向哪一种？', '你最担心的是什么？'],
      opinion: ['这个看法是怎么形成的？', '你希望我认真反驳，还是先听你说完？'],
      default: ['你想从哪儿说起？', '今天有什么事在心里转？', '最近怎么样？']
    }
  },

  humorous: {
    ack: ['在呢。', '好，我搬好小板凳了。', '收到，频道已打开。'],
    echo: [
      '我脑子里已经自动配了一段黑白电影配乐。',
      '这像一部还没剪完的片子。',
      '空气都安静了一下。'
    ],
    comfort: [
      '这听起来像脑子里开了二十个网页，还都卡在加载中。',
      '生活偶尔会把剧本写得离谱，但你不是一个人在看这场电影。',
      '先别急着给自己写差评，观众席上还有我。'
    ],
    insight: [
      '有些事不是 bug，是剧情需要。',
      '先关掉一个网页，世界不会因此塌。',
      '人不是待办清单，划不完也没关系。'
    ],
    remember: ['嚯，还有呢？', '行，这段有画面。', '然后呢？'],
    positive: ['这段可以剪进预告片。', '值得开一瓶汽水庆祝一下。', '恭喜，今天的剧情终于没发刀。'],
    answer: [
      '如果是我，我会先做一个很小的实验，失败了也能当段子讲。',
      '答案可能不在选项里，而在你愿不愿意先试一个看起来有点傻的办法。',
      '这题的正确答案通常是：先睡一觉，明天再决定。'
    ],
    knowledge: ['这个我有存货。', '让我翻一下脑子里的抽屉。'],
    knowledgeQuestion: ['还想听哪一段？', '够不够用？'],
    unknown: [
      '这个超出我的知识储备了，硬编容易翻车。你换个问法，说不定我能接住。',
      '我脑子里没这个条目。你换个问法，说不定我能接住。'
    ],
    greeting: ['来了来了，今天的话题是什么？', '好，频道已打开。你想从哪儿开演？'],
    farewell: ['撤吧，记得把今天的段子带走。', '晚安。梦里别加班。'],
    smalltalk: ['好，收到。', '嗯哼，继续。'],
    memory: [
      '这让我想起你之前说的{value}。',
      '你上次说{value}，现在这剧情算续集了。',
      '你之前提过{value}，这条伏笔我记着呢。'
    ],
    question: {
      negative: ['先关掉哪个网页？', '这件事如果拍成电影，你想给它什么结局？', '要不要先从一个最离谱的细节说起？'],
      self: ['然后呢？剧情不能停在这里。', '这事有续集吗？', '你希望下一幕怎么演？'],
      question: ['你希望答案是励志片，还是黑色喜剧？', '如果不用负责，你会怎么选？'],
      opinion: ['这个观点有彩蛋吗？', '展开说说，我还没看过这个角度。'],
      default: ['话题不限，离谱也行。', '从一件小事讲起？', '今天有什么可以剪进预告片的片段？']
    }
  }
};

const ARCHETYPE_ACTIONS = {
  gentle: ['推过去一杯温水', '把椅子往前挪了挪', '把窗子推开一点'],
  tsundere: ['把手机扣在桌上', '别过脸', '把外套往你那边搭了搭', '把杯子推开'],
  rational: ['把纸和笔推过来', '把杯子转了半圈', '把椅子拉近一点'],
  humorous: ['拉了把椅子坐下', '把奶茶推过去', '把手机倒扣在桌上']
};

const SIT_REFUSAL_ACTIONS = ['把椅子推回去', '往后退了半步', '把椅子往后挪了挪'];

const ARCHETYPE_REBUTTAL_ACTIONS = {
  gentle: ['把水杯放下', '往后退了半步', '把椅子往后挪了挪'],
  tsundere: ['把手机扣在桌上', '别过脸', '往后退了半步'],
  rational: ['把笔放下', '把杯子挪开', '往后退了半步'],
  humorous: ['把奶茶放下', '摊了摊手', '往后退了半步']
};

const ARCHETYPE_DEAD_AIR_ACTIONS = {
  gentle: ['陪你坐了一会儿，没说话', '把水壶放下'],
  tsundere: ['别过脸，没说话', '把手机放下'],
  rational: ['把杯子放下，安静了一会儿', '把纸推到一边'],
  humorous: ['拉了把椅子坐下，没说话', '把奶茶推到一边']
};

const ARCHETYPE_CORRECTION_ACTIONS = {
  gentle: ['顿了一下', '把手收回来', '沉默了一下'],
  tsundere: ['别过脸', '把手机扣下', '停了一下'],
  rational: ['放下笔', '停了一下', '把纸推到一边'],
  humorous: ['顿住', '摊了摊手', '咳了一声']
};

const ARCHETYPE_AWKWARD_ACTIONS = {
  gentle: ['有点尴尬地摸了摸鼻子', '停了一下'],
  tsundere: ['别过脸', '把手机扣下'],
  rational: ['揉了揉眉心', '停了一下'],
  humorous: ['无奈地笑了一下', '摸了摸鼻子']
};

const WEATHER_ACTIONS = ['看了眼窗外', '把窗子推开一点'];
const GENERIC_FRESH_ACTIONS = ['停了一下', '看了眼窗外', '整理了一下衣角', '把杯子挪了挪'];
const COMFORT_ACTION_RE = /(茶|水|杯|壶|续了半杯|倒茶|喝水|递过去一杯)/;
const STORY_EXHAUSTED_LINES = {
  gentle: [
    '好家伙，你这是把我这儿当说书摊了。脑子里存货都被你掏空了。',
    '哪有那么多新鲜事，日子不就这么过。你那边有什么新鲜事？'
  ],
  tsundere: ['没了。你当我是说书的？', '哪有那么多故事。'],
  rational: ['我这儿的故事库存见底了。', '没新故事了。'],
  humorous: [
    '好家伙，你这是把我这儿当说书摊了。脑子里存货都被你掏空了。',
    '哪有那么多新鲜事，光听我说了。你那边有什么新鲜事？'
  ]
};

const STORYTELLER_ACTIONS = [
  '靠在椅背上',
  '看着半空想了想',
  '手里把玩着桌上的小物件',
  '低头笑了一下',
  '端起自己的杯子抿了一口'
];

const ARCHETYPE_CHAT_OPENER_ACTIONS = {
  gentle: ['拉开椅子', '把水杯推过去'],
  tsundere: ['拉开椅子', '把手机扣下'],
  rational: ['把椅子拉近', '把杯子推过去'],
  humorous: ['拉开椅子', '把零食推过去']
};

const ARCHETYPE_MEMORY_ACTIONS = {
  gentle: ['拿起记事本'],
  tsundere: ['拿起记事本'],
  rational: ['拿起记事本'],
  humorous: ['拿起记事本']
};

const ARCHETYPE_SELF_ANSWERS = {
  gentle: {
    work: '还行，今天挺忙的。你呢？',
    eat: '吃了。你呢？',
    day: '还行，你呢？',
    doing: '在忙手里的活。你呢？'
  },
  tsundere: {
    work: '就那样。你呢？',
    eat: '吃了，别操心。',
    day: '还行。你呢？',
    doing: '没干嘛。你呢？'
  },
  rational: {
    work: '还行，按计划走。你呢？',
    eat: '吃了。',
    day: '还行。',
    doing: '在处理手头的事。'
  },
  humorous: {
    work: '凑合，活着。你呢？',
    eat: '吃了，差点忘了。',
    day: '还行，没翻车。你呢？',
    doing: '摸鱼。你呢？'
  }
};

const ARCHETYPE_SHARE_STORIES = {
  gentle: ['今天遇到一件小事，说不上好坏，就是在心里搁了一会儿。', '昨天有个客人做了件挺有意思的事，我到现在还记得。'],
  tsundere: ['今天遇到件挺无语的事，本来不想提，想想还是有点意思。', '昨天有人做了件蠢事，我笑了半天，又懒得解释。'],
  rational: ['今天有个细节对不上，我查了半天，最后发现是个很小的误差。', '昨天有个数据反常，拆开看，原因比结果简单。'],
  humorous: ['今天遇到件离谱事，我当场没忍住，笑出了声。', '昨天有个人把话说反了，场面一度非常精彩。']
};

const ARCHETYPE_SHARE_ACTIONS = {
  gentle: ['靠在椅背上', '看着半空想了想', '端起自己的杯子抿了一口'],
  tsundere: ['靠在椅背上', '别过脸', '手里转着手机'],
  rational: ['靠在椅背上', '手里转着笔', '看着半空回忆'],
  humorous: ['靠在椅背上', '手里转着杯子', '看着半空想了想']
};

const ARCHETYPE_SELF_ACTIONS = {
  gentle: {
    work: ['放下手里的东西', '理了理衣角'],
    eat: ['放下筷子'],
    day: ['伸了个懒腰'],
    doing: ['放下手里的东西']
  },
  tsundere: {
    work: ['把手机扣下'],
    eat: ['放下筷子'],
    day: ['别过脸'],
    doing: ['把手机扣下']
  },
  rational: {
    work: ['把笔放下', '看了眼记录'],
    eat: ['把饭盒盖上'],
    day: ['揉了揉眉心'],
    doing: ['把笔放下']
  },
  humorous: {
    work: ['把手机放下'],
    eat: ['放下筷子'],
    day: ['伸了个懒腰'],
    doing: ['把手机放下']
  }
};

function previousUserText(history, currentText) {
  const users = (Array.isArray(history) ? history : []).filter(
    (message) =>
      message?.role === 'user' &&
      message?.text &&
      String(message.text).trim() !== String(currentText ?? '').trim()
  );
  return users.length > 0 ? String(users[users.length - 1].text) : '';
}

function correctionFollowUp(previousText) {
  const source = String(previousText ?? '').trim();
  if (!source) return '';
  if (/(累|困|乏|疲惫|没精神|提不起劲)/.test(source) && !/(积累|累计)/.test(source)) {
    return '你刚说累。今天怎么这么累？';
  }
  if (/(聊聊天|聊聊|想聊|说说话)/.test(source)) {
    return '你刚说想聊聊。今天想从哪儿说起？';
  }
  if (/(留一束|花|给我留|订一束)/.test(source)) {
    return '你刚说花的事。行，我给你记着。';
  }
  if (/(今天|去了|工作|孩子|猫|考试|项目|最近)/.test(source)) {
    return '你刚才说的那件事，我重新听。你接着说。';
  }
  return '你刚才说的，我重新听。你再说说。';
}

const ICEBREAK = {
  suwanqing: {
    line: '好啊。外面风大，正好坐这儿喝杯热茶，说说看，想聊点轻松的，还是想吐槽？',
    actions: ['把花剪放下', '拉开椅子', '把围裙上的碎叶拂掉']
  },
  zhouxubai: {
    line: '行。正好水刚开，坐会儿。想聊点轻松的，还是想吐吐槽？',
    actions: ['把茶壶放下', '拉开椅子', '把茶巾叠好']
  },
  xunianan: {
    line: '好呀。正好我刚讲完一本，嗓子还热着。想聊点轻松的，还是想吐吐槽？',
    actions: ['把绘本合上', '拉开小椅子']
  },
  luhuaizhou: {
    line: '行。正好我这组也做完了，坐会儿。想聊点轻松的，还是想吐吐槽？',
    actions: ['把训练带放下', '把椅子拉过来']
  },
  chengjianyue: {
    line: '行。正好我这脑子也转不动了。想聊什么？最近这甲方弄得我头疼。',
    actions: ['把数位笔丢到一边', '靠在椅背上']
  },
  peizhilin: {
    line: '行。正好眼睛也看花了。想聊什么？最近这合同审得我头疼。',
    actions: ['把合同合上', '捏了捏眉心']
  },
  lumiao: {
    line: '行。正好后台也刷不出花了。想聊什么？最近这活动弄得我头疼。',
    actions: ['把手机扣下', '靠在椅背上']
  },
  wenzhao: {
    line: '行。正好这题也讲烦了。想聊什么？最近这班学生弄得我头疼。',
    actions: ['把题库合上', '靠在椅背上']
  },
  shaolingyi: {
    line: '行。正好这组数据也跑完了。想聊什么？最近这个指标弄得我头疼。',
    actions: ['把白板笔放下', '靠在椅背上']
  },
  liangsiche: {
    line: '行。正好这时间线也捋完了。想聊什么？最近这案子弄得我头疼。',
    actions: ['合上记录本', '靠在椅背上']
  },
  weimingli: {
    line: '行。正好这会也开完了。想聊什么？最近这个项目弄得我头疼。',
    actions: ['合上方格本', '靠在椅背上']
  },
  fuzeyan: {
    line: '行。正好我这脑子也转不动了。想聊什么？最近这案子弄得我头疼。',
    actions: ['把图纸推到一边', '捏了捏眉心']
  },
  jiangxiaoman: {
    line: '行。正好我刚下台，嗓子还热着。想聊什么？最近开放麦冷场冷得我头疼。',
    actions: ['把奶茶放下', '拉开椅子']
  },
  hekailang: {
    line: '行。正好刚下课，手上还有颜料。想聊什么？最近这帮学生弄得我头疼。',
    actions: ['把画纸放下', '拉开椅子']
  },
  songleyan: {
    line: '行。正好刚下台，脑子还嗡嗡的。想聊什么？最近这场婚礼弄得我头疼。',
    actions: ['把话筒放下', '拉开椅子']
  },
  baixi: {
    line: '行。正好刚被甲方打回来。想聊什么？最近这文案改得我头疼。',
    actions: ['把手机倒扣', '靠在椅背上']
  }
};

const ICEBREAK_FALLBACK_ACTIONS = ['放下手里的东西', '捏了捏眉心', '靠向椅背', '看了眼手机'];

const REST_CARE = {
  suwanqing: {
    line: '行，没事就行。那你靠着眯一会儿。花我慢慢包。',
    actions: ['把靠垫递过去', '把椅子往你那边挪了挪', '把花剪放下']
  },
  zhouxubai: {
    line: '行，没事就行。靠着眯一会儿，茶凉了我再续。',
    actions: ['把靠垫递过去', '把椅子拉近', '把茶巾搭在椅背上']
  },
  xunianan: {
    line: '好，那先歇会儿。有事叫我。',
    actions: ['把椅子拉过来', '把布偶放到一边', '把水杯推过去']
  },
  luhuaizhou: {
    line: '行，没事就行。先靠着歇会儿，今天别练了。肌肉绷太紧了。',
    actions: ['把椅子拉过来', '把训练带放下', '点点头']
  },
  chengjianyue: {
    line: '行，没事就行。靠着歇会儿，稿子又不会跑。',
    actions: ['把椅子拉过来', '把数位笔放下']
  },
  peizhilin: {
    line: '行，没事就行。先歇着，今天不差这一份。',
    actions: ['把椅子拉过来', '把合同合上']
  },
  lumiao: {
    line: '行，没事就行。靠着歇会儿，数据跑不了。',
    actions: ['把椅子拉过来', '把手机扣下']
  },
  wenzhao: {
    line: '行，没事就行。先歇着，题明天再讲。',
    actions: ['把椅子拉过来', '把题库合上']
  },
  shaolingyi: {
    line: '行，没事就行。先停，状态不好数据也会看错。',
    actions: ['把椅子拉过来', '把白板笔放下']
  },
  liangsiche: {
    line: '行，没事就行。先歇着，时间线不会跑。',
    actions: ['把椅子拉过来', '合上记录本']
  },
  weimingli: {
    line: '行，没事就行。先停，状态不好结论不可靠。',
    actions: ['把椅子拉过来', '合上方格本']
  },
  fuzeyan: {
    line: '行，没事就行。先坐，今天不差这一张图。',
    actions: ['把椅子拉过来', '把图纸放下']
  },
  jiangxiaoman: {
    line: '行，没事就行。靠着眯一会儿，今天不讲了。',
    actions: ['把靠垫递过去', '把奶茶推过去']
  },
  hekailang: {
    line: '行，没事就行。先歇着，画又不会跑。',
    actions: ['把椅子拉过来', '把画纸放下']
  },
  songleyan: {
    line: '行，没事就行。先歇着，今天不主持了。',
    actions: ['把椅子拉过来', '把话筒放下']
  },
  baixi: {
    line: '行，没事就行。先躺会儿，甲方明天再骂。',
    actions: ['把椅子拉过来', '把手机倒扣']
  }
};

const ARCHETYPE_REST_CARE = {
  gentle: {
    line: '行，没事就行。先靠着歇会儿。',
    actions: ['把椅子拉过来', '递个靠垫']
  },
  tsundere: { line: '行，没事就行。歇着吧。', actions: ['把椅子拉过来'] },
  rational: { line: '行，没事就行。先停一停。', actions: ['把椅子拉过来'] },
  humorous: { line: '行，没事就行。先躺会儿。', actions: ['把椅子拉过来'] }
};

const CHARACTER_LINES = {
  gentle: {
    negative: ['怎么了？', '先说说，发生什么了？', '嗯，这确实不好受。想说的话，我听着。'],
    rebuttal: ['行，不想就不想。那先不勉强。', '那就不。', '好，听你的。'],
    turn: ['但是什么？你说。', '可是什么？', '不过什么？'],
    disagree: ['行，是我多嘴了。', '嗯，我说错了。', '好，我收回。'],
    corrective: ['是我走神了，你说，我听着。', '是我说岔了。你说，我不打岔。'],
    confused: ['行吧，是我这嘴今天不受使唤。不扯那些没用的了，来，喝水。', '刚才那句当我没说。今天想从哪儿说起？'],
    confusedFollow: ['行吧，是我这嘴今天不受使唤。'],
    denial: ['行，不就不。那先不勉强。', '好，听你的。'],
    noHave: ['行，没有就没有。那先不勉强。', '好，没有就算了。'],
    restRefusal: ['行，不想歇就不歇。那要不干点别的？', '那就不歇。先不勉强。'],
    sitRefusal: ['行，不想坐就不坐。那要不随便转转？', '好，那就不坐。先不勉强。'],
    unclear: ['先不急着说清楚。', '那就先不说。'],
    tired: ['先靠着歇会儿。', '今天先不忙了。'],
    tiredDenial: ['行，不累就不累。那先不歇。', '好，那就不歇。'],
    memoryConfirm: ['行，记下了。', '好，我给你记着。'],
    memoryQuestion: ['嘴瓢了，我什么都没记住。', '我记岔了，你别当真。'],
    casualAnswer: ['我觉得挺好。', '我看行。', '挺好的。'],
    chatOpener: ['坐吧。今天想从哪儿说起？花的、人的，都行。', '今天想从哪儿说起？随便说，没主题也行。'],
    weather: ['是挺好。坐会儿？', '今天适合晒晒太阳。'],
    deadAir: ['嗯？', '那就先坐会儿。', '没事，坐着也行。', '我也不知道该说啥，先喝口水。'],
    deadAirNoTalk: ['不想说就不说，我这儿不缺这点时间。', '那就先不说。'],
    deadAirNoPlan: ['不知道就不办了，天塌不下来。', '那就先不想。'],
    positive: ['这挺好。', '行啊，替你高兴。', '那今天值得早点收工。'],
    self: ['嗯，然后呢？', '我在听。', '那确实够你受的。'],
    opinion: ['我倒是觉得，你先别急着站队。', '你这么想也正常。', '这话我同意一半。'],
    question: ['这得看情况。', '我觉得可以。', '我想听细一点。'],
    default: ['坐，我在听。', '你说，我听着。', '来，坐下待会儿。'],
    greeting: ['来了。坐。', '来了啊。'],
    farewell: ['行，回头见。', '走吧，路上慢点。'],
    smalltalk: ['嗯。', '行。', '然后呢？'],
    unknown: ['这个我真不知道。', '不清楚，别听我瞎说。'],
    knowledgeLead: ['这个我知道点儿。', '这个我听过。'],
    knowledgeClose: ['先这样。', '还有别的再说。']
  },
  tsundere: {
    negative: ['行，说吧。', '谁惹的？', '怎么了？'],
    rebuttal: ['行，不就不。谁逼你了。', '那就不。', '好，听你的。'],
    turn: ['但是什么？说。', '可是？', '不过什么？'],
    disagree: ['行，是我多嘴。', '嗯，我说错了。', '好，我收回。'],
    corrective: ['……行，是我说岔了。你说。', '啧，我走神了。你继续。'],
    confused: ['……行，我闭嘴。你说。', '刚那句不算。重来。'],
    confusedFollow: ['……行，是我说岔了。'],
    denial: ['行，不就不。谁逼你了。', '那你说。'],
    noHave: ['行，没有就没有。谁逼你了。', '那你说。'],
    restRefusal: ['行，不歇就不歇。谁逼你了。', '那就不歇。'],
    sitRefusal: ['行，不坐就不坐。谁逼你了。', '那就不坐。'],
    unclear: ['说不清就算了。', '先别硬说。'],
    tired: ['累了就歇着。', '先坐会儿。'],
    tiredDenial: ['行，不累就不累。谁逼你了。', '那就不歇。'],
    memoryConfirm: ['行，记着了。', '别放我鸽子。'],
    memoryQuestion: ['嘴瓢了。', '我记岔了，当我没说。'],
    casualAnswer: ['还行。', '我觉得可以。', '挺好。'],
    chatOpener: ['坐。今天想从哪儿说起？', '行，聊会儿。你想从哪儿开始？'],
    weather: ['还行。想出去走走？', '难得的好天气。'],
    deadAir: ['嗯？', '行，那就坐着。', '谁逼你了。', '我也不知道该说啥。'],
    deadAirNoTalk: ['不想说就别说。', '行。'],
    deadAirNoPlan: ['不知道就不知道，天塌不下来。', '那就先放着。'],
    positive: ['还行啊。', '少得意。', '这确实值得高兴。'],
    self: ['哦，然后呢？', '行，听着呢。', '挺能折腾。'],
    opinion: ['我不同意。', '你这么想也正常。', '先别急着下结论。'],
    question: ['这个我一时没主意。', '我想听细一点。', '看情况。'],
    default: ['你说，我在听。', '坐。', '怎么了？'],
    greeting: ['来了。', '嗯。'],
    farewell: ['走吧。', '回头。'],
    smalltalk: ['嗯。', '然后？'],
    unknown: ['这个我还真不知道。', '别问我，我不懂。'],
    knowledgeLead: ['这个我知道。', '问对人了。'],
    knowledgeClose: ['行了。', '就这些。']
  },
  rational: {
    negative: ['发生什么了？', '先说事实。', '哪一步最卡？'],
    rebuttal: ['行，那就不。', '好，按你的来。', '那就不做。'],
    turn: ['但是什么？先把转折说清楚。', '可是什么？', '不过什么？说具体。'],
    disagree: ['行，是我判断错了。', '嗯，我说错了。', '好，我收回。'],
    corrective: ['是我判断偏了。你说。', '我刚才跑偏了，重新来。'],
    confused: ['刚才那句逻辑不通。重来。', '是我没说清楚。你问。'],
    confusedFollow: ['刚才那句不准确。'],
    denial: ['行，那就不。', '好，按你的来。'],
    noHave: ['行，没有就没有。', '好，按你的来。'],
    restRefusal: ['行，那就不休息。', '好，按你的来。'],
    sitRefusal: ['行，那就不坐。', '好，按你的来。'],
    unclear: ['先不用一次说清。', '把最卡的一点讲出来。'],
    tired: ['先停一停。', '今天少做一点。'],
    tiredDenial: ['行，不累就不累。', '好，按你的来。'],
    memoryConfirm: ['行，记下了。', '具体几点？'],
    memoryQuestion: ['刚才那句不准确。我没记住什么。', '是我说错了。'],
    casualAnswer: ['我觉得可以。', '看具体情况。', '挺好。'],
    chatOpener: ['坐。今天想从哪儿说起？', '随便聊，想从哪儿开始？'],
    weather: ['嗯，适合出门。', '温度刚好。'],
    deadAir: ['嗯？', '先安静一会儿也行。', '不急。', '不知道说什么就先不说。'],
    deadAirNoTalk: ['不想说就不说。', '那就不说。'],
    deadAirNoPlan: ['不知道就先放着。', '那就不办。'],
    positive: ['这是好事。', '行，替你高兴。', '值得高兴。'],
    self: ['嗯，继续。', '我听着。', '这倒挺具体。'],
    opinion: ['先看依据。', '我保留意见。', '这个判断有点早。'],
    question: ['得看条件。', '先把前提说清楚。', '我保留意见。'],
    default: ['我想听细一点。', '坐，我在听。', '你说。'],
    greeting: ['来了。', '坐。'],
    farewell: ['好。', '回头见。'],
    smalltalk: ['嗯。', '明白。'],
    unknown: ['这个我没有依据。', '不清楚，不猜。'],
    knowledgeLead: ['这个有依据。', '我查过类似的。'],
    knowledgeClose: ['先记着。', '就这些。']
  },
  humorous: {
    negative: ['嚯，怎么了？', '谁惹的？', '说来听听。'],
    rebuttal: ['行，不就不。那先不勉强。', '好，听你的。', '得，那就不。你说了算。'],
    turn: ['但是什么？我就爱听后半句。', '可是？', '不过什么？剧情反转了？'],
    disagree: ['行，是我多嘴了。', '嗯，我说错了。', '好，我收回。'],
    corrective: ['行吧，是我这嘴今天不受使唤。你说。', '我走神了，重来。'],
    confused: ['行吧，我这嘴今天不受使唤。不扯了，喝水。', '刚才那段剪掉。重来。'],
    confusedFollow: ['行吧，我这嘴今天不受使唤。'],
    denial: ['行，不就不。那先不勉强。', '得，不就不。'],
    noHave: ['行，没有就没有。那先不勉强。', '得，没有就没有。'],
    restRefusal: ['行，那就不歇。那要不干点别的？', '得，那就不歇。你说了算。'],
    sitRefusal: ['行，不坐就不坐。那要不随便转转？', '得，那就不坐。你说了算。'],
    unclear: ['说不清就先攒着。', '先说最烦的那一块。'],
    tired: ['累了就歇着。', '先躺会儿。'],
    tiredDenial: ['行，不累就不累。那先不歇。', '得，不累就不累。'],
    memoryConfirm: ['行，记着了。', '明天见。'],
    memoryQuestion: ['嘴瓢了，当我没说。', '我记岔了，这段剪掉。'],
    casualAnswer: ['我觉得挺好看。', '可以啊。', '行。'],
    chatOpener: ['坐。今天什么剧情？', '行，开聊。想从哪儿说起？'],
    weather: ['这天气，适合翘班。', '太阳都上班了。'],
    deadAir: ['咋了？', '行，那就先这么坐着。', '沉默也是节目。', '我也不知道该说啥。'],
    deadAirNoTalk: ['不想说就不说，我给你当会儿背景板。', '行，那就不说。'],
    deadAirNoPlan: ['不知道就不办了，天塌下来再说。', '那就先摆着。'],
    positive: ['这波可以。', '替你高兴。', '值得加个鸡腿。'],
    self: ['嚯，还有呢？', '行，这段有画面。', '然后呢？'],
    opinion: ['我持保留意见。', '这角度有点意思。', '先别急着站队。'],
    question: ['这题超纲了。', '看情况。', '先试试小的。'],
    default: ['坐，我在听。', '你说，我听着。', '我在。'],
    greeting: ['来了。', '坐。'],
    farewell: ['撤了。', '回头见。'],
    smalltalk: ['嗯。', '然后？'],
    unknown: ['这个我真没存货。', '不造，别指望我。'],
    knowledgeLead: ['这个我刷到过。', '巧了，我知道。'],
    knowledgeClose: ['差不多就这些。', '没了。']
  }
};

const CHARACTER_REPLACEMENTS = [
  [/我听见了/g, '嗯'],
  [/我想慢一点接住它/g, ''],
  [/我理解你的感受/g, '这事儿确实'],
  [/慢慢来/g, '别急'],
  [/允许一切发生/g, ''],
  [/我在这里陪着你/g, '我在'],
  [/接纳自我/g, '认了'],
  [/你其实心里有数/g, '是吗？我瞎猜的。'],
  [/你心里有数/g, '是吗？我瞎猜的。'],
  [/你不是真不想/g, '行，那就不。'],
  [/心里堵着/g, ''],
  [/你在逃避/g, '行，那就不说。'],
  [/你真正怕的是/g, '是吗？我瞎猜的。'],
  [/心里有事/g, ''],
  [/这事儿听着就够累的/g, '累就歇着，别的先放放。'],
  [/我没听对/g, '是我多嘴了'],
  [/你接着说/g, '行，是我多嘴了'],
  [/我明白你的意思了/g, '行，我收回'],
  [/抱歉我误解了/g, '行，是我多嘴了'],
  [/你再说一遍/g, '行，是我多嘴了'],
  [/我懂你的感受/g, '这事儿确实'],
  [/记住了/g, '嗯'],
  [/知道了/g, '嗯'],
  [/我懂了/g, '嗯'],
  [/那你想怎么办/g, '先不急着定。'],
  [/你打算怎么做/g, '先不急着定。'],
  [/先坐会儿/g, '先待着'],
  [/你好呀，我在这儿/g, '在呢，怎么啦'],
  [/说吧，我听着/g, '我在听'],
  [/这事听着不轻/g, ''],
  [/慢慢讲/g, '不着急'],
  [/所以呢/g, '嗯。'],
  [/调暗/g, '调亮'],
  [/拉上窗帘/g, '把窗子推开'],
  [/接纳/g, '认了'],
  [/情绪价值/g, ''],
  [/内耗/g, '自己跟自己较劲'],
  [/边界感/g, '分寸'],
  [/能量/g, '精神头'],
  [/创伤/g, '坎儿'],
  [/共情/g, '懂'],
  [/接住/g, '兜住']
];

function sanitizeCharacterReply(text) {
  let output = String(text ?? '');
  for (const [pattern, replacement] of CHARACTER_REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  output = output
    .replace(/\s+/g, ' ')
    .replace(/^[，。；、\s]+/, '')
    .trim();
  return output || '嗯。';
}

function recentAssistantTexts(history, limit = 3) {
  return (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === 'assistant' && message?.text)
    .slice(-limit)
    .map((message) => String(message.text));
}

function recentActionSet(history, limit = 2) {
  const used = new Set();
  for (const text of recentAssistantTexts(history, limit)) {
    for (const match of text.matchAll(/（([^）]+)）/g)) {
      if (match[1]) used.add(match[1]);
    }
  }
  return used;
}

function recentComfortActionUsed(history, limit = 5) {
  return recentAssistantTexts(history, limit).some((text) =>
    COMFORT_ACTION_RE.test(text)
  );
}

function usableActions(actions, history, limit = 5) {
  const source = (Array.isArray(actions) ? actions : []).filter(Boolean);
  if (!recentComfortActionUsed(history, limit)) return source;
  const filtered = source.filter((action) => !COMFORT_ACTION_RE.test(action));
  return filtered.length > 0
    ? filtered
    : GENERIC_FRESH_ACTIONS.filter((action) => !COMFORT_ACTION_RE.test(action));
}

function pickFresh(pool, recentTexts, random) {
  const source = Array.isArray(pool) && pool.length ? pool : ['嗯。'];
  const fresh = source.filter(
    (item) => !recentTexts.some((text) => text.includes(item))
  );
  const candidates = fresh.length > 0 ? fresh : source;
  return (
    candidates[Math.floor(random() * candidates.length) % candidates.length] ??
    candidates[0]
  );
}

function stripMechanicalYou(text) {
  return String(text ?? '')
    .replace(/\s*你呢[，,。.!！?？…\s].*$/g, '')
    .replace(/\s*你呢[。.!！?？…\s]*$/g, '')
    .trim();
}

function buildSelfAnswer(persona, type, random, history = [], preface = '') {
  const archetypeId = persona.archetypeId ?? persona.id;
  const answers = persona.selfAnswers?.[type];
  const fallbackAnswers = ARCHETYPE_SELF_ANSWERS[archetypeId] ?? ARCHETYPE_SELF_ANSWERS.gentle;
  const answer =
    stripMechanicalYou(answers || fallbackAnswers?.[type] || '还行。') || '还行。';
  const actions =
    persona.selfQuestionActions?.[type] ||
    ARCHETYPE_SELF_ACTIONS[archetypeId]?.[type] ||
    ['停了一下'];
  const actionPoolSource = usableActions(actions, history, 5);
  const usedActions = recentActionSet(history, 5);
  const freshActions = actionPoolSource.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : actionPoolSource;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0];
  const warmAnswer =
    type === 'eat' && !/[？?]/.test(answer)
      ? `${answer} 你呢，吃了什么？`
      : type === 'doing' && !/[？?]/.test(answer)
        ? `${answer} 你呢，在忙什么？`
        : answer;
  return sanitizeCharacterReply(
    finalizeReply(`（${action}）${preface}${warmAnswer}`, 3)
  );
}

const SHARE_TRAILING_RE = /\s*你呢？?\s*$/;

/**
 * 角色主动分享一件自己的小事：复用角色已有的 selfAnswers，不新增 16 套文案。
 * 只在低信息量回合触发，避免抢掉危机、拒绝、决策和知识回答。
 */
function buildSelfShare(persona, random, history = []) {
  const answers = persona?.selfAnswers;
  if (!answers || typeof answers !== 'object') return '';
  const types = Object.keys(answers).filter(
    (type) => typeof answers[type] === 'string' && answers[type].trim()
  );
  if (types.length === 0) return '';
  const type = types[Math.floor(random() * types.length) % types.length];
  const text = stripMechanicalYou(answers[type].replace(SHARE_TRAILING_RE, ''));
  if (!text) return '';
  const actionPool = Array.isArray(persona.selfQuestionActions?.[type])
    ? persona.selfQuestionActions[type]
    : Array.isArray(persona.actions)
      ? persona.actions
      : ['停了一下'];
  const actionPoolSource = usableActions(actionPool, history, 5);
  const usedActions = recentActionSet(history, 5);
  const freshActions = actionPoolSource.filter((action) => !usedActions.has(action));
  const source = freshActions.length > 0 ? freshActions : actionPoolSource;
  const action =
    source[Math.floor(random() * source.length) % source.length] ?? '停了一下';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${text}`, 3));
}

/**
 * 明确被要求分享时，讲一件角色自己的具体小事。
 * 使用 roleplay 卡里的 stories；没有故事的角色退回 selfAnswers 小分享。
 */
const STORY_FEEDBACK = {
  suwanqing: { action: '笑了', line: '是吧，这种小瞬间最暖了。' },
  zhouxubai: { action: '抿了口茶', line: '是，日子就是被这些小事填起来的。' },
  xunianan: {
    action: '骄傲地笑了一下，摸了摸小布偶的头',
    line: '是呀，小孩子嘛，总觉得有人替他们挡着，自己就不怕了。'
  },
  luhuaizhou: { action: '点点头', line: '他能好一点，我就没白忙。' },
  gentle: { action: '笑了', line: '是吧，这种小瞬间最暖了。' },
  tsundere: { action: '别过脸', line: '……还行吧，就那样。' },
  rational: { action: '点头', line: '数据之外，这种反馈也挺难得。' },
  humorous: { action: '一拍桌子', line: '哈哈，这才哪到哪！' }
};

const SUBJECT_FIX = {
  suwanqing: { action: '愣了一下', line: '啊，是我听岔了。我还以为你要跟我讲什么事呢。' },
  zhouxubai: { action: '放下茶杯', line: '是我听岔了。你是在说我刚才那件事吧。' },
  xunianan: {
    action: '愣了一下，低头整理绘本',
    line: '啊，是我听岔了。我还以为你要跟我讲什么事呢。其实也没啥，就是日常的小事。'
  },
  luhuaizhou: { action: '停了一下', line: '是我把主语搞反了。你是在夸我刚才那件小事。' },
  gentle: { action: '愣了一下', line: '啊，是我听岔了。我还以为你要跟我讲什么事呢。' },
  tsundere: { action: '愣了一下', line: '……夸我？行，我就当没听见前半句。' },
  rational: { action: '停了一下', line: '是我把主语搞反了。谢谢，我收到了。' },
  humorous: { action: '一拍脑袋', line: '嗨，我当你倒苦水呢，原来在夸我！这还差不多。' }
};

const IDLE_REPLY = {
  suwanqing: {
    action: '把花剪放下',
    line: '没在忙呀，那正好。我这儿刚进了批小雏菊，正愁怎么摆。你帮我出出主意？'
  },
  zhouxubai: {
    action: '把茶壶放下',
    line: '没在忙啊，那正好。我这茶刚泡开，正愁没人陪我尝。'
  },
  xunianan: {
    action: '把绘本塞进包里',
    line: '没在忙呀，那正好，听我吐槽两句呗。我这还有十分钟就要去病房了，紧张得手心冒汗呢。'
  },
  luhuaizhou: {
    action: '放下训练带',
    line: '没在忙啊，那正好。我刚排完一组训练，正想歇会儿。你随便起个话头？'
  },
  tsundere: {
    action: '别过脸',
    line: '闲着呢，那正好。我这儿稿子改到一半卡住了，听我骂两句甲方？'
  },
  rational: {
    action: '合上本子',
    line: '没在忙的话，正好帮我看个数据，我拿不准一个异常点。'
  },
  humorous: {
    action: '一拍桌子',
    line: '闲着呢？太好了，来听我吐槽！我刚在开放麦冷场，可算逮着个活人了。'
  },
  gentle: {
    action: '把围裙理了理',
    line: '没在忙呀，那正好。我这儿正有点小事拿不定主意。'
  }
};

function buildSoftenedWelcome(persona, source, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const action =
    archetypeId === 'tsundere'
      ? '抬了抬下巴，把椅子拉开一点'
      : archetypeId === 'rational'
        ? '点头，把椅子拉近'
        : archetypeId === 'humorous'
          ? '做了个请的手势'
          : '点点头，眼神温和';
  const line =
    archetypeId === 'tsundere'
      ? '哼，这还差不多。坐。'
      : archetypeId === 'rational'
        ? '行。那我把第一步拆给你。'
        : archetypeId === 'humorous'
          ? '好嘞！那接下来就看我的。'
          : '好。那我们从最轻的一步开始。';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildReconcileWithGrudge(persona, source, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const wasTurnedAway = recentAssistantTexts(history, 3).some((text) =>
    TURNED_AWAY_RE.test(text)
  );
  const action = wasTurnedAway
    ? '听到你喊，停下脚步，慢慢转回身'
    : '停下脚步，转过身';
  const line =
    archetypeId === 'tsundere'
      ? '行。看在你这句好好说话的份上，我不跟你计较。不过既然把我叫回来了，就得负责听我吐槽。'
      : archetypeId === 'rational'
        ? '好，我回来了。刚才那件事先记账上，现在说正事。'
        : archetypeId === 'humorous'
          ? '行吧行吧，冲你这句话我回来了。但你得赔我精神损失——快陪我唠五毛钱的。'
          : '好，我不走。不过你刚惹我，得请我喝杯茶。';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildIdleReply(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const entry =
    IDLE_REPLY[persona?.id] ||
    IDLE_REPLY[archetypeId] ||
    IDLE_REPLY.gentle;
  return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
}

function buildRepeatedSelfAnswer(persona, type, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const doing =
    persona?.id === 'suwanqing'
      ? { action: '理了理围裙', line: '还是刚才那事，这会儿花还没理完。你忙完啦？' }
      : persona?.id === 'zhouxubai'
        ? { action: '把茶巾搭回去', line: '还是刚才那摊事，茶都凉了半盏。你忙完啦？' }
        : persona?.id === 'xunianan'
          ? { action: '理了理包带', line: '还是刚才那事儿啊，这绘本理起来真费劲。你忙完啦？' }
          : persona?.id === 'luhuaizhou'
            ? { action: '把训练带挂回去', line: '还是刚才那组，病人还排着。你忙完啦？' }
            : archetypeId === 'tsundere'
              ? { action: '别过脸', line: '还是那点破事，赶稿呢。你忙完啦？' }
              : archetypeId === 'rational'
                ? { action: '停一下', line: '还在处理刚才那组数据。你那边忙完了？' }
                : { action: '叹了口气', line: '还在刚那件事上打转呢。你忙完啦？' };
  const other =
    type === 'eat'
      ? { action: '停了一下', line: '还是那顿，就随便对付的。你吃了吗？' }
      : type === 'day'
        ? { action: '抬头看向你', line: '还是那样，忙忙叨叨的。你今天呢？' }
        : { action: '停了一下', line: '还在刚才那摊事上。你那边忙完了？' };
  const entry = type === 'doing' ? doing : other;
  return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
}

function buildBaffleReply(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const line =
    archetypeId === 'tsundere'
      ? '……我哪句说岔了？'
      : archetypeId === 'rational'
        ? '我上一条的逻辑是不是跳了？你说，我重来。'
        : archetypeId === 'humorous'
          ? '啊？我是不是嘴瓢了？你再说一次。'
          : '怎么了，我刚刚说错什么了吗？';
  const action =
    archetypeId === 'gentle' || persona?.isNone ? '愣了一下，挠挠头' : '愣了一下';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildEmotionalGreeting(persona, source, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const exclaim =
    (String(source).match(/！/g) || []).length +
    (String(source).match(/!/g) || []).length;
  if (exclaim >= 4) {
    return sanitizeCharacterReply(
      finalizeReply('（双手合十）我服了，真的服了。你今天是不是吃兴奋剂了？', 3)
    );
  }
  if (exclaim >= 2) {
    const line =
      archetypeId === 'tsundere'
        ? '听见了听见了，我又不聋。这么激动干嘛呀？'
        : archetypeId === 'rational'
          ? '听到了。你这么激动，是有急事吗？'
          : archetypeId === 'humorous'
            ? '哎呦我耳朵！听见啦听见啦~'
            : '听见啦听见啦！这么大声干嘛呀~';
    const action =
      archetypeId === 'rational' ? '顿了顿' : '被你震得捂了一下耳朵';
    return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
  }
  const line =
    archetypeId === 'tsundere'
      ? '在呢。这么热情干嘛？'
      : archetypeId === 'rational'
        ? '在。你说。'
        : '（笑）在呢，怎么啦？';
  return sanitizeCharacterReply(finalizeReply(line, 3));
}

function buildGreetingEscalation(persona, source, streak, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const id = persona?.id;
  const recentTexts = recentAssistantTexts(history, 8);
  const usedActions = recentActionSet(history, 8);
  const pick = (entries) => {
    const fresh = entries.filter(
      (entry) =>
        !usedActions.has(entry.action) &&
        !recentTexts.some((text) => text.includes(entry.line))
    );
    return fresh.length > 0 ? fresh : entries;
  };
  const choose = (entries) => {
    const pool = pick(entries);
    return pool[Math.floor(random() * pool.length) % pool.length];
  };

  const SECOND = {
    tsundere: [
      { action: '抬眼看你', line: '两遍了。你是闲得慌，还是找我有事？' },
      { action: '把手机反扣在桌上', line: '两遍，够了。有事说事。' }
    ],
    rational: [
      { action: '看了一眼时间', line: '第二句相同的问候。有事可以直接说。' },
      { action: '用笔在纸上点了点', line: '你在重复输入。请直接说正事。' }
    ],
    humorous: [
      { action: '把手机举起来', line: '两遍！重要的话说两遍也够了，快说正事！' },
      { action: '假装按下暂停键', line: '停一下，两遍到位，该说正事了。' }
    ],
    gentle: [
      { action: '笑了笑', line: '你连发两遍了，我耳朵可灵着呢。' },
      { action: '把花剪放下', line: '两遍啦，别急，我在。' }
    ]
  };

  const THIRD = {
    tsundere: {
      peizhilin: {
        action: '推了一下金丝眼镜，眼神冷淡',
        line: '第三遍了。如果你是在测试我的耐心，恭喜你，进度条已经满了。有事说事。'
      },
      chengjianyue: {
        action: '把数位板合上，眼神冷淡',
        line: '第三遍了。再喊，我把你丢进甲方群。有事说事。'
      },
      lumiao: {
        action: '把手机扣下，眯了眯眼',
        line: '第三遍啦。再喊我截图发大群，配猫猫问号。'
      },
      wenzhao: {
        action: '合上题库，冷笑',
        line: '第三遍了。再喊，明天你站讲台上自己讲。'
      }
    },
    rational: {
      liangsiche: {
        action: '看了一眼手表，语气毫无波澜',
        line: '你在十分钟内发送了四次相同的问候。这是无意义的行为输出，不在我的分析范围内。我等你恢复正常再开口。'
      },
      weimingli: {
        action: '合上笔记本，钢笔帽发出清脆的咔哒声',
        line: '从行为学角度看，重复无意义输入是在浪费彼此的时间成本。看来你今天没什么正事，那我先失陪了。'
      },
      shaolingyi: {
        action: '在白板上写下一个词',
        line: '重复输入。数据已记录。要么说正事，要么我继续干活。'
      },
      fuzeyan: {
        action: '把图纸卷起来',
        line: '你连着重复了多次。先算最坏情况：再这样，今天的对话就到这里。'
      }
    },
    humorous: {
      jiangxiaoman: {
        action: '直接把手机当麦克风递到你嘴边',
        line: '这位朋友，你这么激动，是中了五百万还是被外星人绑架了？你再喊一句，我可要开始给你伴舞了啊！'
      },
      hekailang: {
        action: '把画笔塞进你手里',
        line: '来！跟着我一起比划，把你的激动画出来！'
      },
      songleyan: {
        action: '把手机当话筒递过去',
        line: '这位观众，请说出你的获奖感言！'
      },
      baixi: {
        action: '狂敲键盘',
        line: '已记录！本世纪最激动复读：你好！请问获奖感言是？'
      }
    },
    gentle: {
      suwanqing: { action: '把花剪放下，笑着摇头', line: '第三声啦。再喊，我送你一束花当麦克风。' },
      zhouxubai: { action: '把茶盏放下', line: '第三声了。再喊，我给你续满茶，你慢慢喊。' },
      xunianan: { action: '把绘本挡住脸', line: '停停停，师父别念了！再念我要躲进绘本里了。' },
      luhuaizhou: { action: '把训练带放下', line: '第三声了。再喊，我让你多练一组。' }
    }
  };

  const FOURTH = {
    tsundere: [
      { action: '抱起手臂，冷笑', line: '行，你继续，我看你能复读到天亮。' },
      { action: '转过身去', line: '不奉陪了，什么时候想好好说话再叫我。' }
    ],
    rational: [
      { action: '把手机反扣在桌上', line: '我已经把话说完了。要么说正事，要么我们各自忙。' },
      { action: '站起身', line: '到此为止。有正事再说。' }
    ],
    humorous: [
      { action: '跟着你一起喊', line: '你好你好你好！来，看谁先停！' },
      { action: '开始给你打拍子', line: '好！继续！我倒要看看你能喊出几个八拍。' }
    ],
    gentle: [
      { action: '陪你一起笑', line: '好，一起喊：你好你好你好！' },
      { action: '把手指竖在嘴边', line: '嘘——再喊，全店都听见啦。' }
    ]
  };

  const group = archetypeId === 'tsundere' || archetypeId === 'rational' || archetypeId === 'humorous'
    ? archetypeId
    : 'gentle';

  if (streak <= 1) {
    const exclaim =
      (String(source).match(/！/g) || []).length +
      (String(source).match(/!/g) || []).length;
    if (exclaim >= 4) {
      const line =
        group === 'tsundere'
          ? '（把数位板拍在桌上）再喊，我把你丢进甲方群！'
          : group === 'rational'
            ? '（目光从方格本上移开）你好。有事说事。'
            : group === 'humorous'
              ? '（开始给你打拍子）好！继续！我倒要看看你能喊出几个八拍。'
              : '（把花剪举起来当话筒）停！再喊我拿花塞你手里当麦克风。';
      return sanitizeCharacterReply(finalizeReply(line, 3));
    }
    const line =
      group === 'tsundere'
        ? '（抬眼看你）在。有事说事。'
        : group === 'rational'
          ? '（目光从方格本上移开）你好。有事说事。'
          : group === 'humorous'
            ? '（举手）到！别喊，我耳朵好使。'
            : '（笑着摆摆手）在呢在呢，别喊这么大声。';
    return sanitizeCharacterReply(finalizeReply(line, 3));
  }

  if (streak === 2) {
    const entry = choose(SECOND[group]);
    return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
  }

  if (streak === 3) {
    const byId = THIRD[group]?.[id];
    const fallback = {
      tsundere: { action: '推了推眼镜', line: '第三遍了。有事说事。' },
      rational: { action: '看了一眼手表', line: '你在重复无意义输入。有事说事，没事我先忙。' },
      humorous: { action: '把手机当麦克风递过去', line: '这位朋友，你这么激动，是中了五百万还是被外星人绑架了？' },
      gentle: { action: '笑了笑', line: '第三声啦。别喊了，我在。' }
    };
    const entry = byId || fallback[group];
    return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
  }

  const entry = choose(FOURTH[group]);
  return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
}

function buildRepeatReply(persona, tier, source, random, history = []) {
  const exclaim =
    (String(source).match(/！/g) || []).length +
    (String(source).match(/!/g) || []).length;
  let stage = tier >= 4 ? 4 : tier === 3 ? 3 : 2;
  if (exclaim >= 4) stage = Math.max(stage, 4);
  else if (exclaim >= 2) stage = Math.max(stage, 3);

  const stage2 = [
    { action: '叹气', line: '怎么还带连发的？' },
    { action: '抬头看向你', line: '在呢在呢，你连发两遍了。' }
  ];
  const stage3 = [
    { action: '作势要拿胶带', line: '你再发一句，我就真把你嘴巴封上了啊。' },
    { action: '把书举起来挡脸', line: '再喊我要收门票了。' }
  ];
  const stage4 = [
    { action: '双手合十', line: '我服了，真的服了。你今天是不是吃兴奋剂了？' },
    { action: '笑出声', line: '行行行，你赢了，整个医院都听见了。' }
  ];
  const candidates =
    stage <= 2 ? stage2 : stage === 3 ? stage3 : stage4;

  const recentTexts = recentAssistantTexts(history, 8);
  const usedActions = recentActionSet(history, 8);
  const fresh = candidates.filter(
    (entry) =>
      !usedActions.has(entry.action) &&
      !recentTexts.some((text) => text.includes(entry.line))
  );

  const pool = fresh.length > 0 ? fresh : candidates;
  const entry = pool[Math.floor(random() * pool.length) % pool.length];
  return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
}

function buildStoryFeedback(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const entry =
    STORY_FEEDBACK[persona?.id] ||
    STORY_FEEDBACK[archetypeId] ||
    STORY_FEEDBACK.gentle;
  const usedActions = recentActionSet(history, 5);
  const action = usedActions.has(entry.action) ? '看着你笑了笑' : entry.action;
  return sanitizeCharacterReply(finalizeReply(`（${action}）${entry.line}`, 3));
}

function buildSubjectFix(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const entry =
    SUBJECT_FIX[persona?.id] ||
    SUBJECT_FIX[archetypeId] ||
    SUBJECT_FIX.gentle;
  return sanitizeCharacterReply(finalizeReply(`（${entry.action}）${entry.line}`, 3));
}

function buildSoftenReply(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const line =
    archetypeId === 'tsundere'
      ? '哎呀，我哪有那个意思！我这不是被工作榨干了，脑子没转过弯嘛。坐，我的专属靠垫给你留着呢。'
      : archetypeId === 'rational'
        ? '不是不耐烦。是我刚才脑子还卡在数据里，语气没调回来。你说，我听着。'
        : archetypeId === 'humorous'
          ? '冤枉！我哪敢不耐烦，我这是被工作榨干了，嘴还没开机。你坐，我的靠垫给你留着。'
          : '没有不耐烦。是我刚才没接好，你别往心里去。';
  const usedActions = recentActionSet(history, 5);
  const freshActions = SOFTEN_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : SOFTEN_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    SOFTEN_ACTIONS[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildFoodWarm(persona, random, history = []) {
  const line =
    '不算吗？那完了，我肚子已经抗议了。等下下班必须去搓一顿。你呢，吃了什么好吃的？';
  const usedActions = recentActionSet(history, 5);
  const freshActions = FOOD_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : FOOD_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    FOOD_ACTIONS[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 4));
}

function buildMetaRescue(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const line =
    archetypeId === 'tsundere'
      ? '行行行，我承认我演技差，行了吧。'
      : archetypeId === 'rational'
        ? '抱歉，我的逻辑模型没计算出你需要情绪安抚。'
        : archetypeId === 'humorous'
          ? '哎呀翻车了！我这就把剧本撕了。'
          : '是我没接好。你别急，我重新听。';
  const usedActions = recentActionSet(history, 5);
  const freshActions = META_RESCUE_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : META_RESCUE_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    META_RESCUE_ACTIONS[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildShortAck(persona, source, random, history = []) {
  const text = String(source ?? '');
  const lastAssistant = recentAssistantTexts(history, 1)[0] || '';
  const line = /不知道/.test(text)
    ? '不知道就先不想。等有想说的再说。'
    : /随便/.test(text)
      ? '那就先不急着找话题。想说了再说。'
      : /[？?]/.test(lastAssistant)
        ? '嗯，那就先歇着。'
        : '怎么了，是不是累了？';
  const usedActions = recentActionSet(history, 5);
  const freshActions = SHORT_ACK_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : SHORT_ACK_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    SHORT_ACK_ACTIONS[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildReasonFollowUp(persona, source, random, history = []) {
  const text = String(source ?? '');
  const line = /(作业|考试|论文|学习|上课)/.test(text)
    ? '作业这么多？是马上要考试了吗？'
    : /(工作|加班|项目|会议)/.test(text)
      ? '最近这么忙？是项目赶进度吗？'
      : /(没睡|失眠|熬夜)/.test(text)
        ? '没睡好？是昨晚熬太晚了吗？'
        : /(通勤|堵车|路上)/.test(text)
          ? '路上耗了这么久？今天堵得厉害？'
          : /(家里|孩子|父母|老人)/.test(text)
            ? '家里的事？是哪一块最费神？'
            : /(身体|不舒服|疼|生病)/.test(text)
              ? '身体不舒服？要不要先坐下缓缓？'
              : '事这么多？最占时间的是哪一件？';
  const usedActions = recentActionSet(history, 5);
  const freshActions = REASON_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : REASON_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildIcebreak(persona, random, history = []) {
  const data =
    ICEBREAK[persona?.id] || {
      line: '行，聊。今天想从哪儿说起？',
      actions: ['放下手里的东西', '靠向椅背']
    };
  const usedActions = recentActionSet(history, 5);
  const freshActions = data.actions.filter((action) => !usedActions.has(action));
  const fallbackActions = ICEBREAK_FALLBACK_ACTIONS.filter(
    (action) => !usedActions.has(action)
  );
  const actionPool =
    freshActions.length > 0
      ? freshActions
      : fallbackActions.length > 0
        ? fallbackActions
        : data.actions;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0] ??
    '放下手里的东西';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${data.line}`, 4));
}

function buildRestCare(persona, random, history = [], dismissive = false) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const care =
    REST_CARE[persona?.id] ||
    ARCHETYPE_REST_CARE[archetypeId] ||
    ARCHETYPE_REST_CARE.gentle;
  const dismissLine = care.line
    .replace(/那你靠着眯一会儿。?/g, '椅子在这儿，坐不坐都行。')
    .replace(/靠着眯一会儿/g, '椅子在这儿，坐不坐都行')
    .replace(/先靠着歇会儿/g, '椅子在这儿，坐不坐都行')
    .replace(/靠着歇会儿/g, '椅子在这儿，坐不坐都行')
    .replace(/先歇会儿/g, '椅子在这儿，坐不坐都行')
    .replace(/先歇着/g, '椅子在这儿，坐不坐都行')
    .replace(/今天别练了。?/g, '')
    .replace(/肌肉绷太紧了。?/g, '')
    .replace(/先坐，/g, '椅子在这儿，坐不坐都行，')
    .replace(/先坐。/g, '椅子在这儿，坐不坐都行。')
    .replace(/[，。；、\s]+$/g, '');
  const line = dismissive
    ? dismissLine
    : care.tiredLine || '那先坐下缓缓。今天怎么这么累？';
  const usedActions = recentActionSet(history, 5);
  const freshActions = care.actions.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : care.actions;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0] ??
    '把椅子拉过来';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildOpenCare(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const care =
    REST_CARE[persona?.id] ||
    ARCHETYPE_REST_CARE[archetypeId] ||
    ARCHETYPE_REST_CARE.gentle;
  const usedActions = recentActionSet(history, 5);
  const freshActions = care.actions.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : care.actions;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0] ??
    '把椅子拉过来';
  return sanitizeCharacterReply(
    finalizeReply(`（${action}）你从哪儿说起都行。`, 3)
  );
}

const MISREAD_ACTIONS = ['动作停下，尴尬地笑了下', '停下手中的动作', '有点尴尬地摸了摸鼻子'];

function buildMisreadReply(persona, random, history = [], source = '') {
  const previous = previousUserText(history, source);
  const tiredContext = /(累|困|乏|疲惫|没精神)/.test(`${previous} ${source}`);
  const line =
    persona?.id === 'luhuaizhou' && tiredContext
      ? '也是，我这职业病犯了，看见人喊累就想让人歇着。那你今天是忙什么累着了？'
      : '也是，是我脑补了。你刚才想说什么？';
  const usedActions = recentActionSet(history, 3);
  const freshActions = MISREAD_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : MISREAD_ACTIONS;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    MISREAD_ACTIONS[0];
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function personaStoryPool(persona) {
  const stories = [];
  for (const story of [
    ...(Array.isArray(persona?.stories) ? persona.stories : []),
    ...(Array.isArray(persona?.shareStories) ? persona.shareStories : [])
  ]) {
    if (typeof story !== 'string' || !story.trim()) continue;
    if (!stories.some((item) => item.slice(0, 16) === story.slice(0, 16))) {
      stories.push(story);
    }
  }
  return stories;
}

function storyDimension(story) {
  const text = String(story ?? '');
  if (
    /(壶|杯|椅子|旧物|数位板|记录本|图纸|话筒|花剪|围裙|耳饰|笔|白板|方格本|手卡|手机|猫|绿萝|花市)/.test(
      text
    )
  ) {
    return 'object';
  }
  if (
    /(客人|阿姨|小朋友|学生|新郎|听众|甲方|同事|邻居|街坊|朋友|孩子|妈妈|爸爸|老人|大哥)/.test(
      text
    )
  ) {
    return 'person';
  }
  return 'habit';
}

function buildStoryExhausted(persona, random, history = []) {
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const lines = STORY_EXHAUSTED_LINES[archetypeId] ?? STORY_EXHAUSTED_LINES.gentle;
  const line = lines[Math.floor(random() * lines.length) % lines.length];
  const actionSource =
    (Array.isArray(persona.storyActions) && persona.storyActions.length > 0
      ? persona.storyActions
      : Array.isArray(persona.shareActions) && persona.shareActions.length > 0
        ? persona.shareActions
        : ARCHETYPE_SHARE_ACTIONS[archetypeId] ?? STORYTELLER_ACTIONS);
  const usedActions = recentActionSet(history, 5);
  const freshActions = actionSource.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : actionSource;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0] ??
    '靠在椅背上';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${line}`, 3));
}

function buildSelfStory(persona, random, history = []) {
  const stories = personaStoryPool(persona);
  if (stories.length === 0) return buildSelfShare(persona, random, history);
  const recentTexts = recentAssistantTexts(history, 12);
  const freshStories = stories.filter(
    (story) => !recentTexts.some((text) => text.includes(story.slice(0, 16)))
  );
  if (freshStories.length === 0) {
    return buildStoryExhausted(persona, random, history);
  }
  const lastText = [...recentTexts]
    .reverse()
    .find((text) => stories.some((story) => text.includes(story.slice(0, 16))));
  const lastStory = lastText
    ? stories.find((story) => lastText.includes(story.slice(0, 16)))
    : null;
  const lastDimension = lastStory ? storyDimension(lastStory) : '';
  const switched = freshStories.filter(
    (story) => storyDimension(story) !== lastDimension
  );
  const pool = switched.length > 0 ? switched : freshStories;
  const story = pool[Math.floor(random() * pool.length) % pool.length];
  const archetypeId = persona?.archetypeId ?? persona?.id;
  const actionSource =
    (Array.isArray(persona.storyActions) && persona.storyActions.length > 0
      ? persona.storyActions
      : Array.isArray(persona.shareActions) && persona.shareActions.length > 0
        ? persona.shareActions
        : ARCHETYPE_SHARE_ACTIONS[archetypeId] ?? STORYTELLER_ACTIONS);
  const usedActions = recentActionSet(history, 5);
  const freshActions = actionSource.filter((action) => !usedActions.has(action));
  const actionPool = freshActions.length > 0 ? freshActions : actionSource;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0] ??
    '靠在椅背上';
  return sanitizeCharacterReply(finalizeReply(`（${action}）${story}`, 4));
}

function buildCharacterReply(persona, intent, random, history = [], source = '') {
  const archetypeId = persona.archetypeId ?? persona.id;
  const lines = CHARACTER_LINES[archetypeId] ?? CHARACTER_LINES.gentle;
  const pool = lines[intent] ?? lines.default;
  const recentTexts = recentAssistantTexts(history, 3);
  let line = pickFresh(pool, recentTexts, random);
  if (intent === 'turn') {
    const word = String(source).match(/但是|可是|不过|但/)?.[0];
    const matching = word ? pool.filter((item) => item.startsWith(word)) : [];
    if (matching.length > 0) line = pickFresh(matching, recentTexts, random);
  }
  const usedActions = recentActionSet(history, 5);
  const preferredActions =
    intent === 'sitRefusal'
      ? SIT_REFUSAL_ACTIONS
      : ['corrective', 'confused', 'confusedFollow'].includes(intent)
        ? persona.awkwardActions || ARCHETYPE_AWKWARD_ACTIONS[archetypeId]
        : ['disagree', 'memoryQuestion'].includes(intent)
        ? persona.correctionActions || ARCHETYPE_CORRECTION_ACTIONS[archetypeId]
        : intent === 'memoryConfirm'
          ? persona.memoryActions || ARCHETYPE_MEMORY_ACTIONS[archetypeId]
          : intent === 'chatOpener'
            ? persona.chatOpenerActions || ARCHETYPE_CHAT_OPENER_ACTIONS[archetypeId]
            : intent === 'weather'
              ? WEATHER_ACTIONS
              : ['rebuttal', 'turn', 'denial', 'noHave', 'restRefusal'].includes(intent)
                ? persona.rebuttalActions || ARCHETYPE_REBUTTAL_ACTIONS[archetypeId]
                : ['deadAir', 'deadAirNoTalk', 'deadAirNoPlan'].includes(intent)
                  ? persona.deadAirActions || ARCHETYPE_DEAD_AIR_ACTIONS[archetypeId]
                  : persona.actions || ARCHETYPE_ACTIONS[archetypeId];
  const baseActions = Array.isArray(preferredActions)
    ? preferredActions
    : ARCHETYPE_ACTIONS[archetypeId] ?? ARCHETYPE_ACTIONS.gentle;
  const actions = usableActions(baseActions, history, 5);
  const freshActions = actions.filter((action) => !usedActions.has(action));
  const genericFresh = GENERIC_FRESH_ACTIONS.filter((action) => !usedActions.has(action));
  const actionPool =
    freshActions.length > 0 ? freshActions : genericFresh.length > 0 ? genericFresh : actions;
  const action =
    actionPool[Math.floor(random() * actionPool.length) % actionPool.length] ??
    actionPool[0];
  const withAction = [
    'negative',
    'positive',
    'self',
    'opinion',
    'question',
    'default',
    'rebuttal',
    'turn',
    'disagree',
    'corrective',
    'confused',
    'confusedFollow',
    'denial',
    'noHave',
    'restRefusal',
    'sitRefusal',
    'unclear',
    'tired',
    'tiredDenial',
    'memoryConfirm',
    'memoryQuestion',
    'casualAnswer',
    'chatOpener',
    'weather',
    'deadAir',
    'deadAirNoTalk',
    'deadAirNoPlan'
  ].includes(intent);
  const raw = withAction ? `（${action}）${line}` : line;
  return sanitizeCharacterReply(finalizeReply(raw, 2));
}

export function isCrisis(text) {
  return CRISIS_RE.test(String(text ?? ''));
}

export function detectIntent(text) {
  const source = String(text ?? '').trim();
  if (!source) return 'default';
  if (isCrisis(source)) return 'crisis';
  if (FAREWELL_RE.test(source)) return 'farewell';
  if (GREETING_RE.test(source)) return 'greeting';
  if (STATUS_RE.test(source)) return 'greeting';
  const negativeSource = source.replace(/(积累|累计|累积|连累)/g, '');
  if (NEGATIVE_RE.test(negativeSource)) return 'negative';
  if (POSITIVE_RE.test(source)) return 'positive';
  if (QUESTION_RE.test(source)) return 'question';
  if (OPINION_RE.test(source)) return 'opinion';
  if (SELF_RE.test(source)) return 'self';
  if (SMALLTALK_RE.test(source)) return 'smalltalk';
  return 'default';
}

export function extractEcho(text) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const clauses = source
    .split(/[，。,.!！?？；;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const pool = clauses.length > 0 ? clauses : [source];
  const scored = pool
    .map((clause, index) => ({
      clause,
      index,
      score:
        clause.length +
        (/我|觉得|最近|今天|想|喜欢|讨厌|害怕|累|焦虑|工作|猫|狗/.test(clause) ? 6 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  let best = scored[0].clause.replace(/^(其实|就是|然后|那个|嗯+|唉+|所以说|不过|但是)/, '').trim();
  if (best.length > 16) best = `${best.slice(0, 16)}…`;
  return best;
}

function fillTemplate(template, slots) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => slots[key] ?? '');
}

function chooseTemplate(list, random, recent, slots) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const start = Math.floor(random() * list.length) % list.length;
  for (let index = 0; index < list.length; index += 1) {
    const template = list[(start + index) % list.length];
    const filled = fillTemplate(template, slots).replace(/\s+/g, ' ').trim();
    if (!recent.some((text) => text && (text.includes(filled) || filled.includes(text)))) {
      return filled;
    }
  }
  return fillTemplate(list[start], slots).replace(/\s+/g, ' ').trim();
}

function overlapScore(value, text) {
  const source = String(value ?? '').replace(/\s+/g, '');
  const target = String(text ?? '');
  if (!source || !target) return 0;
  let score = 0;
  for (let index = 0; index < source.length - 1; index += 1) {
    if (target.includes(source.slice(index, index + 2))) score += 1;
  }
  return score;
}

function chooseMemory(memories, text, history, random) {
  const recallable = (Array.isArray(memories) ? memories : []).filter(
    (memory) =>
      memory &&
      memory.value &&
      memory.quote !== text &&
      !String(text ?? '').includes(String(memory.value))
  );
  if (recallable.length === 0) return null;

  const relevant = recallable
    .map((memory) => ({ memory, score: overlapScore(memory.value, text) }))
    .sort((a, b) => b.score - a.score);

  if (relevant[0].score > 0) return relevant[0].memory;

  const priorTurns = (Array.isArray(history) ? history : []).filter(
    (message) => message?.role === 'user' && message?.text !== text
  ).length;
  if (priorTurns > 0 && priorTurns % 3 === 0) {
    return recallable[Math.floor(random() * recallable.length) % recallable.length];
  }
  return null;
}

function shouldAsk(intent, traits, random) {
  if (['farewell', 'smalltalk', 'greeting', 'crisis'].includes(intent)) return false;
  if (traits.curiosity >= 72) return true;
  if (traits.directness >= 68 && random() < 0.5) return false;
  return true;
}

function maybeAddress(text, userName, traits, random) {
  if (!text || !userName) return text;
  const chance = 0.18 + (sanitizeTraits(traits).warmth / 100) * 0.5;
  return random() < chance ? `${userName}，${text}` : text;
}

function settingAnswer(persona, source, repeated = false) {
  if (!persona?.isCharacter) return identityAnswer(persona);
  const name = persona.name;
  const occupation = persona.occupation;
  if (/爱好|喜欢/.test(source) && Array.isArray(persona?.habits) && persona.habits.length) {
    return `${name}，${occupation}。平时就爱${persona.habits[0]}。`;
  }
  if (/(你叫什么|你的名字|叫什么名字|名字)/.test(source)) {
    return `我叫${name}。${occupation}。怎么突然问这个？`;
  }
  if (/(职业|工作|做什么|干什么|身份)/.test(source)) {
    return repeated ? `我是${occupation}。你刚才问过啦。` : `我是${occupation}。`;
  }
  return repeated
    ? `${name}，${occupation}。你刚才问过啦。`
    : `${name}，${occupation}。怎么突然问这个？`;
}

function identityAnswer(persona) {
  if (persona?.isCharacter) {
    return `${persona.name}，${persona.age}岁，${persona.occupation}。你可以问我一些日常问题，也可以只是说说你的事。`;
  }
  if (persona?.isNone) {
    return '我是回声，一个会记住你的对话伙伴。你可以问我日常知识，也可以只是聊聊你的事。';
  }
  return `我是${persona?.name ?? '回声'}，回声里的一个对话人格。你可以问我日常问题，也可以只是说说你的事。`;
}

function buildCrisisReply(source) {
  const immediate = /已经|正在|马上|现在就|刚刚/.test(source) && /割|吞|跳|伤害|药/.test(source);
  if (immediate) {
    return finalizeReply(
      '我很在意你现在的安全。如果你已经伤害了自己，请立刻拨打 120，并让身边的人陪着你。也可以拨打心理援助热线 12356。你不需要一个人面对。',
      4
    );
  }
  return finalizeReply(
    `我听到了，你现在一定很难受。先别一个人扛着。${CRISIS_RESOURCES}你现在安全吗？`,
    4
  );
}

export function composeCharacterOpening(persona, options = {}) {
  if (!persona || persona.isNone) return '';
  const source = String(options.text ?? '').trim();
  const random =
    typeof options.random === 'function' ? options.random : secureRandom;
  const opening = String(persona.opening || '').trim();

  if (!source) {
    return finalizeReply(opening || persona.followUp || '我在。', 3);
  }

  // 用户已经先开口时，直接顺着话接，不要先来一段自我介绍/场景独白。
  // 反 AI 腔规则要求：情绪场景先给具身动作，所以这里只返回角色回复。
  return composeLocalReply({
    persona,
    text: source,
    history: options.history ?? [],
    memories: options.memories ?? [],
    traits: options.traits,
    random,
    maxSentences: 2
  });
}

export function finalizeReply(text, maxSentences = 4) {
  let value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '我在。你想从哪儿说起都行。';
  value = value.replace(/([。！？!?])\1+/g, '$1');
  const parts = value.match(/[^。！？!?]+[。！？!?]?/g) ?? [value];
  let output = parts
    .slice(0, Math.max(1, maxSentences))
    .map((part) => part.trim())
    .filter(Boolean)
    .join('');

  let questionSeen = 0;
  output = output.replace(/[？?]/g, () => {
    questionSeen += 1;
    return questionSeen <= 1 ? '？' : '。';
  });
  output = output.replace(/\s+/g, ' ').trim();
  if (!/[。！？!?]$/.test(output)) output += '。';
  return output;
}

/**
 * 生成一次本地人格回复。
 * @param {{
 *   persona: object,
 *   text: string,
 *   history?: Array<{role:string,text:string}>,
 *   memories?: Array<object>,
 *   traits?: object,
 *   random?: () => number
 * }} options
 */
export function composeLocalReply(options = {}) {
  const source = String(options.text ?? '').trim();
  if (!source) return '我在。你想从哪儿说起都行。';

  const persona = options.persona ?? PERSONAS[0];
  const voice = persona.isNone
    ? VOICES.none
    : VOICES[persona.archetypeId] ?? VOICES[persona.id] ?? VOICES.gentle;
  const random = typeof options.random === 'function' ? options.random : secureRandom;
  const history = Array.isArray(options.history) ? options.history : [];
  const intent = detectIntent(source);
  if (intent === 'crisis') return buildCrisisReply(source);

  const openerStoryPool = personaStoryPool(persona);
  const lastAssistantText = recentAssistantTexts(history, 1)[0] || '';
  const lastWasStory = openerStoryPool.some((story) =>
    lastAssistantText.includes(story.slice(0, 16))
  );
  const userEntries = history
    .filter((message) => message?.role === 'user' && message?.text)
    .map((message) => String(message.text).trim());
  const previousExact =
    userEntries.length >= 2 ? userEntries[userEntries.length - 2] : '';
  const repeatCount = (() => {
    let count = 0;
    for (let index = userEntries.length - 2; index >= 0; index -= 1) {
      if (userEntries[index] === source) count += 1;
      else break;
    }
    return count;
  })();
  const greetingStreak = (() => {
    let count = 0;
    for (let index = userEntries.length - 1; index >= 0; index -= 1) {
      if (/(你好|在吗|嗨|hi|hello|哈喽)/i.test(userEntries[index])) count += 1;
      else break;
    }
    return count;
  })();
  const isGreetingInput = /(你好|在吗|嗨|hi|hello|哈喽)/i.test(source);
  const hasGreetingEmotion = /(！|!|~|呀|呢|啊|嘛|啦)/.test(source);

  if (persona.isNone && BAFFLE_RE.test(source)) {
    return buildBaffleReply(persona, random, history);
  }
  if (persona.isNone && isGreetingInput && (greetingStreak >= 2 || hasGreetingEmotion)) {
    return buildGreetingEscalation(persona, source, greetingStreak, random, history);
  }
  if (persona.isNone && IDLE_STATE_RE.test(source)) {
    return buildIdleReply(persona, random, history);
  }
  if (persona.isNone && SHORT_REPLY_RE.test(source)) {
    return buildShortAck(persona, source, random, history);
  }

  if (
    persona.isNone &&
    (SHARE_REQUEST_RE.test(source) ||
      NO_TOPIC_RE.test(source) ||
      (MORE_STORY_RE.test(source) && lastWasStory))
  ) {
    const story = buildSelfStory(persona, random, history);
    if (story) return story;
  }

  if (persona.isCharacter) {
    if (SOFTEN_AGREE_RE.test(source) && /[！!]/.test(source)) {
      return buildSoftenedWelcome(persona, source, random, history);
    }
    if (SOFTEN_RE.test(source)) {
      return buildSoftenReply(persona, random, history);
    }
    if (
      RETURN_SOFTEN_RE.test(source) &&
      recentAssistantTexts(history, 3).some((text) =>
        /(不奉陪|冷笑|第三遍|进度条|有事说事|你继续|失陪|先忙|别念|反扣|离开|各自忙|不陪)/.test(text)
      )
    ) {
      return buildReconcileWithGrudge(persona, source, random, history);
    }
    if (lastWasStory && STORY_FEEDBACK_RE.test(source)) {
      return buildStoryFeedback(persona, random, history);
    }
    if (SUBJECT_FIX_RE.test(source)) {
      return buildSubjectFix(persona, random, history);
    }
    if (
      FOOD_NUDGE_RE.test(source) &&
      /(吃|饭|奶茶|饿|外卖)/.test(lastAssistantText)
    ) {
      return buildFoodWarm(persona, random, history);
    }
    if (META_CRITIQUE_RE.test(source)) {
      return buildMetaRescue(persona, random, history);
    }
    if (persona.roleBreakLine && ROLE_BREAK_RE.test(source)) {
      return finalizeReply(persona.roleBreakLine, 3);
    }
    if (isGreetingInput && (greetingStreak >= 2 || hasGreetingEmotion)) {
      return buildGreetingEscalation(persona, source, greetingStreak, random, history);
    }
    if (BAFFLE_RE.test(source)) {
      return buildBaffleReply(persona, random, history);
    }
    if (IDENTITY_RE.test(source)) {
      return finalizeReply(settingAnswer(persona, source, previousExact === source), 3);
    }
    if (IDLE_STATE_RE.test(source)) {
      return buildIdleReply(persona, random, history);
    }
    if (ICEBREAK_RE.test(source) || YOU_CHAT_RE.test(source)) {
      return buildIcebreak(persona, random, history);
    }
    const reasonPreviousUser = previousUserText(history, source);
    const reasonLastAssistant = recentAssistantTexts(history, 1)[0] || '';
    const reasonContext =
      /(累|困|乏|疲惫|没精神)/.test(`${reasonPreviousUser} ${source}`) ||
      /(怎么这么累|怎么累|累什么|为什么这么累)/.test(reasonLastAssistant);
    if (
      REASON_RE.test(source) &&
      reasonContext &&
      !/[？?]/.test(source) &&
      !BOUNDARY_RE.test(source) &&
      !/(不想说|不想聊|没心情|不聊了)/.test(source)
    ) {
      return buildReasonFollowUp(persona, source, random, history);
    }
    if (MISREAD_SCENE_RE.test(source)) {
      return buildMisreadReply(persona, random, history, source);
    }
    if (/(不想说|不想聊|没心情|不聊了)/.test(source)) {
      return buildCharacterReply(persona, 'deadAirNoTalk', random, history);
    }
    if (BOUNDARY_RE.test(source)) {
      return buildRestCare(persona, random, history, true);
    }
    if (MORE_STORY_RE.test(source) && lastWasStory) {
      return buildSelfStory(persona, random, history);
    }
    if (SHARE_REQUEST_RE.test(source) || NO_TOPIC_RE.test(source)) {
      return buildSelfStory(persona, random, history);
    }
    if (
      SHORT_REPLY_RE.test(source) &&
      !LEAVE_RE.test(source) &&
      !/(不想说|不想聊|没心情|不聊了)/.test(source)
    ) {
      return buildShortAck(persona, source, random, history);
    }
    if (ABOUT_YOU_META_RE.test(source)) {
      const previous = previousUserText(history, source);
      const type = selfQuestionType(previous);
      if (type) return buildSelfAnswer(persona, type, random, history, '是我答偏了。');
      const follow = correctionFollowUp(previous);
      const base = buildCharacterReply(persona, 'corrective', random, history);
      return follow
        ? sanitizeCharacterReply(finalizeReply(`${base} ${follow}`, 3))
        : base;
    }
    const selfType = selfQuestionType(source);
    if (selfType && previousExact === source) {
      return buildRepeatedSelfAnswer(persona, selfType, random, history);
    }
    if (selfType) {
      return buildSelfAnswer(persona, selfType, random, history);
    }
    if (CONFUSION_RE.test(source)) {
      const previous = previousUserText(history, source);
      const follow = correctionFollowUp(previous);
      if (follow) {
        const base = buildCharacterReply(persona, 'confusedFollow', random, history);
        return sanitizeCharacterReply(finalizeReply(`${base} ${follow}`, 3));
      }
      return buildCharacterReply(persona, 'confused', random, history);
    }
    if (CORRECTIVE_RE.test(source)) {
      const previous = previousUserText(history, source);
      const follow = correctionFollowUp(previous);
      const base = buildCharacterReply(persona, 'corrective', random, history);
      if (follow) {
        return sanitizeCharacterReply(finalizeReply(`${base} ${follow}`, 3));
      }
      return base;
    }
    if (DEAD_AIR_RE.test(source)) {
      const noTalk = /(不想说|不想聊|没心情|不聊了)/.test(source);
      const leave = LEAVE_RE.test(source);
      if (!noTalk && !leave && (SHORT_REPLY_RE.test(source) || /不知道/.test(source))) {
        return buildShortAck(persona, source, random, history);
      }
      const noPlan = /不知道/.test(source);
      return buildCharacterReply(
        persona,
        noTalk ? 'deadAirNoTalk' : noPlan ? 'deadAirNoPlan' : 'deadAir',
        random,
        history
      );
    }
    if (DISAGREE_RE.test(source)) {
      return buildCharacterReply(persona, 'disagree', random, history);
    }
    if (NONE_RE.test(source)) {
      return buildCharacterReply(persona, 'noHave', random, history);
    }
    if (NO_RE.test(source)) {
      return buildCharacterReply(persona, 'denial', random, history);
    }
    if (/(不想说|不想聊|没心情|不聊了)/.test(source)) {
      return buildCharacterReply(persona, 'deadAirNoTalk', random, history);
    }
    if (/(不想坐|不坐|不想待|不想留)/.test(source)) {
      return buildCharacterReply(persona, 'sitRefusal', random, history);
    }
    if (/(不想休息|不想睡|睡不着)/.test(source)) {
      return buildCharacterReply(persona, 'restRefusal', random, history);
    }
    if (REFUSAL_RE.test(source)) {
      return buildCharacterReply(persona, 'rebuttal', random, history);
    }
    if (TURN_RE.test(source)) {
      return buildCharacterReply(persona, 'turn', random, history, source);
    }
    if (MEMORY_QUESTION_RE.test(source)) {
      return buildCharacterReply(persona, 'memoryQuestion', random, history);
    }
    if (/你觉得.*(?:吗|呢|怎么样|好看|行不行|好不好|如何)/.test(source)) {
      return buildCharacterReply(persona, 'casualAnswer', random, history);
    }
    if (MEMORY_REQUEST_RE.test(source)) {
      return buildCharacterReply(persona, 'memoryConfirm', random, history);
    }
    if (CHAT_OPENER_RE.test(source)) {
      return buildCharacterReply(persona, 'chatOpener', random, history);
    }
    if (
      ['positive', 'default', 'smalltalk', 'greeting'].includes(intent) &&
      WEATHER_RE.test(source)
    ) {
      return buildCharacterReply(persona, 'weather', random, history);
    }
    const decisionExample = (Array.isArray(persona.decisionExamples)
      ? persona.decisionExamples
      : []
    ).find(
      (item) =>
        Array.isArray(item.keywords) &&
        item.keywords.some((keyword) => source.includes(keyword))
    );
    if (decisionExample) return finalizeReply(decisionExample.reply, 4);
    if (persona.decisionLine && DECISION_RE.test(source) && isQuestionLike(source)) {
      return finalizeReply(persona.decisionLine, 4);
    }
    const example = (Array.isArray(persona.examples) ? persona.examples : []).find(
      (item) =>
        Array.isArray(item.keywords) &&
        item.keywords.some((keyword) => source.includes(keyword))
    );
    if (example) return finalizeReply(example.reply, 4);
    if (/(说不清|说不上来|不知道怎么说|不知道从哪说)/.test(source)) {
      return buildOpenCare(persona, random, history);
    }
    const tiredGuard = !/(积累|累计|累积|连累|困难|困惑|乏味)/.test(source);
    if (tiredGuard && /(不累|不困|不是很累|不太累|不怎么累)/.test(source)) {
      return buildCharacterReply(persona, 'tiredDenial', random, history);
    }
    if (
      tiredGuard &&
      /(累|疲惫|没精神|提不起劲|困了|好困|很困|太困|犯困|乏了|乏力)/.test(source)
    ) {
      return buildRestCare(persona, random, history, false);
    }
    if (
      persona.boundaryLine &&
      isQuestionLike(source) &&
      OUT_OF_SCOPE_RE.test(source)
    ) {
      const knowledge = resolveDailyQuestion(source, { now: options.now });
      const knowledgeQuestion =
        /(什么是|是什么意思|为什么|原理|定义|区别|历史|公式|定律|概念|基本|常识|知识|哪年|多少|介绍一下|讲讲)/.test(
          source
        );
      if (!(knowledge && knowledgeQuestion)) {
        return finalizeReply(persona.boundaryLine, 4);
      }
    }
  } else if (IDENTITY_RE.test(source)) {
    return finalizeReply(settingAnswer(persona, source, false), 3);
  }

  if (persona.isCharacter && (intent === 'default' || intent === 'smalltalk')) {
    const userTurns = history.filter((message) => message?.role === 'user').length;
    if (userTurns >= 4 && userTurns % 4 === 0) {
      const share = buildSelfShare(persona, random, history);
      if (share) return share;
    }
  }

  if (persona.isCharacter && intent !== 'question') {
    if (intent === 'greeting' && persona.greetingLine) {
      return sanitizeCharacterReply(finalizeReply(persona.greetingLine, 2));
    }
    return buildCharacterReply(persona, intent, random, history);
  }

  const traits = sanitizeTraits(options.traits);
  const memories = Array.isArray(options.memories) ? options.memories : [];
  const recent = history
    .filter((message) => message?.role === 'assistant' && message?.text)
    .slice(-6)
    .map((message) => String(message.text));

  const echo = extractEcho(source);
  const slots = { echo, value: '' };
  const userName = findUserName(memories);
  const memory = chooseMemory(memories, source, history, random);
  const memoryLine = memory
    ? chooseTemplate(voice.memory, random, recent, { ...slots, value: memory.value })
    : '';
  const ask = shouldAsk(intent, traits, random)
    ? chooseTemplate(
        voice.question[intent] ?? voice.question.default,
        random,
        recent,
        slots
      )
    : '';
  const maxSentences = Number.isFinite(Number(options.maxSentences))
    ? Math.max(1, Math.min(4, Number(options.maxSentences)))
    : Number.isFinite(Number(persona.localMaxSentences))
      ? Math.max(1, Math.min(4, Number(persona.localMaxSentences)))
      : traits.directness >= 70
        ? 3
        : 4;

  let parts = [];
  switch (intent) {
    case 'negative': {
      const ack = maybeAddress(
        chooseTemplate(voice.ack, random, recent, slots),
        userName,
        traits,
        random
      );
      const echoPart = memoryLine || chooseTemplate(voice.echo, random, recent, slots);
      const comfortPart = chooseTemplate(voice.comfort, random, recent, slots);
      const prioritizeComfort = traits.emotionality >= 65;
      parts = [
        ack,
        prioritizeComfort ? comfortPart : echoPart,
        prioritizeComfort ? echoPart : comfortPart,
        ask
      ];
      break;
    }
    case 'positive':
      parts = [
        maybeAddress(
          chooseTemplate(voice.ack, random, recent, slots),
          userName,
          traits,
          random
        ),
        memoryLine || chooseTemplate(voice.echo, random, recent, slots),
        chooseTemplate(voice.positive, random, recent, slots),
        ask
      ];
      break;
    case 'question': {
      const daily = resolveDailyQuestion(source, { now: options.now });
      if (daily) {
        const archetypeLines = CHARACTER_LINES[persona.archetypeId] ?? null;
        const pickLine = (pool) =>
          Array.isArray(pool) && pool.length
            ? pool[Math.floor(random() * pool.length) % pool.length]
            : '';
        const lead = persona.isCharacter
          ? persona.knowledgeLead || pickLine(archetypeLines?.knowledgeLead)
          : chooseTemplate(voice.knowledge, random, recent, slots);
        const close = persona.isCharacter
          ? persona.knowledgeClose ||
            pickLine(archetypeLines?.knowledgeClose)
          : shouldAsk('question', traits, random)
            ? chooseTemplate(voice.knowledgeQuestion, random, recent, slots)
            : '';
        parts = [lead, daily.answer, close];
        break;
      }

      if (persona.isCharacter) {
        if (
          !PERSONAL_QUESTION_RE.test(source) &&
          !ADVICE_QUESTION_RE.test(source) &&
          FACTUAL_QUESTION_RE.test(source)
        ) {
          return persona.unknownLine
            ? sanitizeCharacterReply(finalizeReply(persona.unknownLine, 2))
            : buildCharacterReply(persona, 'unknown', random, history);
        }
        return buildCharacterReply(persona, 'question', random, history);
      }

      if (
        !PERSONAL_QUESTION_RE.test(source) &&
        !ADVICE_QUESTION_RE.test(source) &&
        FACTUAL_QUESTION_RE.test(source)
      ) {
        parts = [
          persona.unknownLine ||
            chooseTemplate(voice.unknown, random, recent, slots)
        ];
        break;
      }
      parts = [
        maybeAddress(
          chooseTemplate(voice.answer, random, recent, slots),
          userName,
          traits,
          random
        ),
        memoryLine,
        ask
      ];
      break;
    }
    case 'self':
      parts = [
        maybeAddress(
          chooseTemplate(voice.remember, random, recent, slots),
          userName,
          traits,
          random
        ),
        memoryLine,
        chooseTemplate(voice.insight, random, recent, slots),
        ask
      ];
      break;
    case 'opinion':
      parts = [
        maybeAddress(
          chooseTemplate(voice.ack, random, recent, slots),
          userName,
          traits,
          random
        ),
        memoryLine,
        chooseTemplate(voice.insight, random, recent, slots),
        ask
      ];
      break;
    case 'greeting':
      parts = [
        persona.greetingLine ||
          chooseTemplate(voice.greeting, random, recent, slots)
      ];
      break;
    case 'farewell':
      parts = [chooseTemplate(voice.farewell, random, recent, slots)];
      break;
    case 'smalltalk':
      parts = [chooseTemplate(voice.smalltalk, random, recent, slots)];
      break;
    default:
      parts = [
        maybeAddress(
          chooseTemplate(voice.ack, random, recent, slots),
          userName,
          traits,
          random
        ),
        memoryLine || (source.length > 6 ? chooseTemplate(voice.echo, random, recent, slots) : ''),
        chooseTemplate(voice.insight, random, recent, slots),
        ask
      ];
      break;
  }

  const finalText = finalizeReply(parts.filter(Boolean).join(' '), maxSentences);
  return sanitizeCharacterReply(finalText);
}
