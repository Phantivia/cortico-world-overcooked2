/**
 * 游戏内部名到中文。订单和食材在游戏里只有图标没有文字，这里按内部名的词根翻译；认不出的原样
 * 保留内部名。
 */

const WORDS: [RegExp, string][] = [
  [/prawn|shrimp/i, '虾'],
  [/fish/i, '鱼'],
  [/seaweed|nori/i, '海苔'],
  [/rice/i, '米'],
  [/cucumber/i, '黄瓜'],
  [/lettuce/i, '生菜'],
  [/tomato/i, '番茄'],
  [/cheese/i, '芝士'],
  [/bun/i, '面包'],
  [/pepperoni/i, '香肠'],
  [/meat|beef|burgerpatty|patty/i, '肉'],
  [/chicken/i, '鸡肉'],
  [/pork/i, '猪肉'],
  [/potato|chips|fries/i, '土豆'],
  [/onion/i, '洋葱'],
  [/mushroom/i, '蘑菇'],
  [/carrot/i, '胡萝卜'],
  [/egg/i, '鸡蛋'],
  [/flour/i, '面粉'],
  [/dough/i, '面团'],
  [/pasta|spaghetti/i, '意面'],
  [/tortilla/i, '玉米饼'],
  [/bean/i, '豆子'],
  [/chocolate/i, '巧克力'],
  [/honey/i, '蜂蜜'],
  [/strawberr/i, '草莓'],
  [/blueberr/i, '蓝莓'],
  [/banana/i, '香蕉'],
  [/pineapple/i, '菠萝'],
  [/apple/i, '苹果'],
  [/batter/i, '面糊'],
  [/olive/i, '橄榄'],
  [/sausage/i, '香肠'],
  [/coconut/i, '椰子'],
  [/lemon/i, '柠檬'],
  [/marshmallow/i, '棉花糖'],
  [/cookie/i, '曲奇'],
  [/pancake/i, '松饼'],
  [/cake/i, '蛋糕'],
  [/dumpling/i, '饺子'],
  [/burrito/i, '卷饼'],
  [/burger/i, '汉堡'],
  [/pizza/i, '披萨'],
  [/salad/i, '沙拉'],
  [/sushi/i, '寿司'],
];

/** 订单菜名：`Sushi_Fish` → 鱼寿司；`Sushi_PlainPrawn` → 虾寿司。 */
export function dishName(raw: string): string {
  const [base, ...rest] = raw.replace(/\(Clone\)/g, '').split('_');
  const head = translate(base);
  if (!rest.length) return head;
  const tail = rest.map(translate).filter(s => s && s !== head).join('');
  return tail ? `${tail}${head}` : head;
}

/** 食材名，带加工态后缀（`Rice:done`）。 */
export function ingredientName(raw: string): string {
  const [name, state] = raw.split(':');
  const base = translate(name);
  return state ? `${stateWord(state, name)}${base}` : base;
}

function stateWord(state: string, name: string): string {
  switch (state) {
    case 'chopped':
      return /rice|seaweed|tortilla|bun/i.test(name) ? '' : '切好的';
    case 'done':
      return '熟';
    case 'cooking':
      return '加热中的';
    case 'overdone':
      return '快糊的';
    case 'burnt':
      return '糊掉的';
    case 'raw':
      return '生';
    default:
      return '';
  }
}

function translate(word: string): string {
  const cleaned = word.replace(/\(Clone\)/g, '').replace(/^(Plain|Boiled|Cooked|Chopped|Sushi(?=[A-Z]))/, '').trim();
  for (const [re, zh] of WORDS) if (re.test(cleaned)) return zh;
  return cleaned || word;
}

const ITEM_KIND: Record<string, string> = {
  plate: '盘子',
  pot: '锅',
  pan: '平底锅',
  basket: '炸篮',
  extinguisher: '灭火器',
  tray: '托盘',
  mixingbowl: '搅拌碗',
};

export function itemKindName(kind: string): string {
  return ITEM_KIND[kind] ?? kind;
}

const STATION_KIND: Record<string, string> = {
  counter: '台面',
  board: '砧板',
  stove: '炉灶',
  crate: '食材箱',
  pass: '出餐口',
  sink: '水槽',
  drying: '沥水架',
  return: '回盘口',
  bin: '垃圾桶',
  mixer: '搅拌机',
  fryer: '油锅',
  oven: '烤箱',
  dispenser: '取盘处',
  fixture: '固定台面',
  other: '设施',
};

export function stationKindName(kind: string): string {
  return STATION_KIND[kind] ?? kind;
}
