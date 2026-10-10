/**
 * 关卡开场黑板（LevelIntroFlowroutine 的 TutorialPopup）上的步骤图画了什么，按游戏里的贴图名查。
 * 图上只有画，标题和一句说明是游戏运行时叠上去的，插件会把那两句连同截图一起送来；这里补的是
 * 看图读出来的做法。贴图名来自游戏资源，行尾注释是用到它的场景。
 */
export const BOARD_STEPS: Record<string, string> = {
  RecipeTutorial_Sashimi: '虾、鱼各自拿到砧板上切好，单独装进盘子就是一份生鱼片。', // s_sushi_1_1
  RecipeTutorial_sushi: '鱼在砧板上切好，米放进锅里煮熟，再拿一张海苔，三样装进同一个盘子。', // s_sushi_1_2
  RecipeTutorial_CleanDirtyPlates: '上过菜的盘子回到回盘口是脏的，拿到水槽里洗，洗好的放在水槽边。', // s_sushi_1_3
  RecipeTutorial_HowToDash: '按冲刺键，厨师朝前冲出一段。', // s_sushi_1_4
  RecipeTutorial_Throw: '生食材可以隔着台面扔给队友，也可以直接扔进锅里；盘子、平底锅、锅扔不了。', // s_rapids_2_1
  RecipeTutorial_HowToMakeBurritos: '肉放进平底锅煎熟，米放进锅里煮熟，和一张玉米饼合在一起。', // s_mine_2_4
  RecipeTutorial_burger: '肉切好，奶酪切好，和汉堡面包合在一起装盘。', // s_mine_2_6
  RecipeTutorial_pasta: '意面放进锅里煮；番茄切好放进平底锅炒；两样合到一个盘子里。', // s_balloon_1_5
  RecipeTutorial_HowToMakeCakes: '面粉、鸡蛋，加切好的巧克力（或别的配料）一起放进搅拌机，搅好的面糊放进烤箱烤。', // s_balloon_6_4
  RecipeTutorial_HowToMakepancakes: '面粉、鸡蛋，可加切好的巧克力，放进搅拌机搅成面糊，倒进平底锅煎。', // s_wizard_school_3_4
  RecipeTutorial_Pizza: '面团在砧板上压成饼底，放上切好的芝士和番茄，放进烤箱烤。', // s_wizard_3_1
  RecipeTutorial_HowToMakeSteamedFood: '鱼或肉切好放进蒸笼；也可以把面粉和切好的肉放进搅拌机，搅好放进蒸笼；蒸熟装盘。', // s_city_h1–h18
  RecipeTutorial_Smoothie: '菠萝、香蕉这类水果切好，放进搅拌机打成奶昔，倒进杯子。', // s_beach_1_1
  RecipeTutorial_KebabGrill: '肉和蔬菜切好，串上签子，放上烤架烤；有人拉风箱给烤架加火。', // s_beach_2_1
  RecipeTutorial_watergun: '用水枪冲掉盘子上的脏东西，也能浇灭火。', // s_resort_1_3
  RecipeTutorial_DLC5_smores: '草莓切好；棉花糖切好放到火上烤；饼干切成片；三样合成一份夹心饼。', // s_campsite_1_1
  RecipeTutorial_DLC5_Backpacks: '背包里装着食材：一个人背上背包，另一个人可以从他背上的包里拿东西。', // s_treehouse_1_3
  RecipeTutorial_DLC5_Breakfast: '香肠和肉切好，和鸡蛋、一罐豆子一起放进平底锅煎，装成一盘早餐。', // s_treehouse_2_1
  RecipeTutorial_ChinaDessert_01: '几种水果各自切好，装进同一个盘子成为果盘。', // s_chinatown_1_1
  DLC10_RecipeTutorial_ChinaDessert_01: '几种水果各自切好，装进同一个盘子成为果盘。', // s_lunar_1_2
  RecipeTutorial_ChinaHotPot_01: '虾、蔬菜、玉米之类放进火锅里，在火上煮熟后盛出来装盘。', // s_chinatown_1_2
  DLC10_RecipeTutorial_ChinaHotPot_01: '虾、蔬菜、玉米之类放进火锅里，在火上煮熟后盛出来装盘。', // s_lunar_1_1
  RecipeTutorial_DLC13_Mooncakes_01: '巧克力、草莓、西瓜这类馅料切好，和面粉、鸡蛋一起放进搅拌机，搅好的放进烤箱烤成月饼。', // s_moonfestival_1_3
  RecipeTutorial_DLC08_MealDeals_01: '汉堡和薯条放在同一个托盘里，作为一份套餐上菜。', // s_day_1_1
  RecipeTutorial_DLC08_Donut: '面粉、鸡蛋、切好的水果放进搅拌机，搅好的面糊放进油炸锅炸成甜甜圈。', // s_day_2_1
  RecipeTutorial_DLC08_HotDog: '香肠放进锅里煮，面包切开，香肠夹进面包；放到酱料机下按按钮挤酱，两种酱可以切换。', // s_night_1_4
  RecipeTutorial_DLC08_DrinksMachine: '按按钮让饮料机出一杯饮料，三种口味可以切换；饮料和汉堡、薯条一起放进托盘。', // s_night_2_2
  RecipeTutorial_DLC08_cannons_01: '厨师钻进大炮，按按钮把自己发射到另一处。', // s_inside_1_2
  RecipeTutorial_DLC11_HotDog: '香肠放进锅里煮，面包切开，香肠夹进面包；放到酱料机下按按钮挤酱，两种酱可以切换。', // s_summer_1_1
  RecipeTutorial_DLC11_IceCreamFloats: '牛奶、冰块、切好的巧克力放进搅拌机打好；按按钮让汽水机出汽水；两样合成冰淇淋汽水。', // s_summer_1_2
  RecipeTutorial_DLC11_SummerSalad: '生菜、椰子、玉米、黄瓜、番茄各自切好，装进同一个盘子。', // s_summer_1_3
  RecipeTutorial_HowToMakeHotChocolate: '牛奶和巧克力放进锅里煮，倒进杯子，再加棉花糖或奶油。', // s_wonderland_1_1
  RecipeTutorial_DLC09_howtomakeotchocolate: '牛奶和巧克力放进锅里煮，倒进杯子，再加棉花糖或奶油。', // s_festivemashup_1_1
  RecipeTutorial_HowToMakeChristmasPuddingandMincePies: '面粉、鸡蛋、切好的橙子和果干放进搅拌机，搅好的放进烤箱烤成圣诞布丁或百果馅饼。', // s_wonderland_1_2
  RecipeTutorial_DLC09_Backpacks: '背包里装着食材：一个人背上背包，另一个人可以从他背上的包里拿东西。', // s_festivemashup_1_3
  RecipeTutorial_DLC09_cannons: '厨师钻进大炮，按按钮把自己发射到另一处。', // s_festivemashup_1_5
  RecipeTutorial_DLC09_hordemode: '怪物来攻厨房：做好的菜从窗口送出去打退它们；墙被打坏了用锤子拿木板修；下方的条是厨房的耐久。', // s_festivemashup_1_2
  RecipeTutorial_DLC09_hordegate: '带锁的尖刺栅门挡着路，付金币才会打开。', // s_festivemashup_1_4
  RecipeTutorial_DLC07_HordeMode_01: '怪物来攻厨房：做好的菜从窗口送出去打退它们；墙被打坏了用锤子拿木板修；下方的条是厨房的耐久。', // s_battlements_01
  RecipeTutorial_DLC07_HordeGate_01: '带锁的尖刺栅门挡着路，付金币才会打开。', // s_battlements_05
  RecipeTutorial_DLC07_EnemyTypes_02: '新敌人：跑得快的辣椒怪，和普通的面包怪一起来。', // s_battlements_04
  RecipeTutorial_DLC07_EnemyTypes_01: '新敌人：冲得快的苹果怪，和普通的面包怪一起来。', // s_battlements_06
  RecipeTutorial_DLC07_Soup_01: '土豆、韭葱放进铡刀，有人按旁边的按钮把它切开，切好的放进锅里煮成汤。', // s_courtyard_1_1
  RecipeTutorial_DLC07_FruitPies: '面粉、鸡蛋、切好的苹果放进搅拌机，搅好的放进烤箱烤成水果派。', // s_courtyard_2_2
  RecipeTutorial_DLC07_NewOven_01: '从煤箱拿煤添进炉子；生肉和土豆放进烤炉烤熟。', // s_keep_1_2
};
