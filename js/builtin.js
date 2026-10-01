/* 内置数据：「四纵四横」客运专线完整站表与大/小站标记，首次运行（或种子版本升级）时 upsert 到 localStorage。
   大站 = 直辖市/省会/计划单列市/主要铁路枢纽或重要地级枢纽；小站 = 其余中间站。
   非官方车站等级，仅供速览。 */
(function (global) {
  'use strict';

  var Domain = global.Domain;
  var Storage = global.Storage;

  var SEED_VERSION = '4';

  /* major: true → 大站；未标记者为小站 */
  var BUILTIN_LINES = [
    {
      name: '京沪高铁（四纵）',
      stations: [
        { n: '北京南', e: 'Beijingnan', major: true },
        { n: '廊坊', e: 'Langfang' },
        { n: '天津西', e: 'Tianjinxi', major: true },
        { n: '天津南', e: 'Tianjinnan' },
        { n: '沧州西', e: 'Cangzhouxi' },
        { n: '德州东', e: 'Dezhoudong' },
        { n: '济南西', e: 'Jinanxi', major: true },
        { n: '泰安', e: "Tai'an" },
        { n: '曲阜东', e: 'Qufudong' },
        { n: '滕州东', e: 'Tengzhoudong' },
        { n: '枣庄', e: 'Zaozhuang' },
        { n: '徐州东', e: 'Xuzhoudong', major: true },
        { n: '宿州东', e: 'Suzhoudong' },
        { n: '蚌埠南', e: 'Bengbunan' },
        { n: '定远', e: 'Dingyuan' },
        { n: '滁州', e: 'Chuzhou' },
        { n: '南京南', e: 'Nanjingnan', major: true },
        { n: '镇江南', e: 'Zhenjiangnan' },
        { n: '丹阳北', e: 'Danyangbei' },
        { n: '常州北', e: 'Changzhoubei' },
        { n: '无锡东', e: 'Wuxidong' },
        { n: '苏州北', e: 'Suzhoubei' },
        { n: '昆山南', e: 'Kunshannan' },
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true }
      ]
    },
    {
      name: '京广深港高铁（四纵）',
      stations: [
        { n: '北京西', e: 'Beijingxi', major: true },
        { n: '涿州东', e: 'Zhuozhoudong' },
        { n: '高碑店东', e: 'Gaobeidiandong' },
        { n: '保定东', e: 'Baodingdong' },
        { n: '定州东', e: 'Dingzhoudong' },
        { n: '正定机场', e: 'Zhengdingjichang' },
        { n: '石家庄', e: 'Shijiazhuang', major: true },
        { n: '高邑西', e: 'Gaoyixi' },
        { n: '邢台东', e: 'Xingtaidong' },
        { n: '邯郸东', e: 'Handandong' },
        { n: '安阳东', e: 'Anyangdong' },
        { n: '鹤壁东', e: 'Hebidong' },
        { n: '新乡东', e: 'Xinxiangdong' },
        { n: '郑州东', e: 'Zhengzhoudong', major: true },
        { n: '新郑东', e: 'Xinzhengdong' },
        { n: '许昌东', e: 'Xuchangdong' },
        { n: '漯河西', e: 'Luohexi' },
        { n: '驻马店西', e: 'Zhumadianxi' },
        { n: '明港东', e: 'Minggangdong' },
        { n: '信阳东', e: 'Xinyangdong' },
        { n: '横店东', e: 'Hengdiandong' },
        { n: '武汉', e: 'Wuhan', major: true },
        { n: '乌龙泉东', e: 'Wulongquandong' },
        { n: '咸宁北', e: 'Xianningbei' },
        { n: '赤壁北', e: 'Chibibei' },
        { n: '岳阳东', e: 'Yueyangdong' },
        { n: '汨罗东', e: 'Miluodong' },
        { n: '长沙南', e: 'Changshanan', major: true },
        { n: '株洲西', e: 'Zhuzhouxi' },
        { n: '衡山西', e: 'Hengshanxi' },
        { n: '衡阳东', e: 'Hengyangdong' },
        { n: '耒阳西', e: 'Leiyangxi' },
        { n: '郴州西', e: 'Chenzhouxi' },
        { n: '乐昌东', e: 'Lechangdong' },
        { n: '韶关', e: 'Shaoguan' },
        { n: '英德西', e: 'Yingdexi' },
        { n: '清远', e: 'Qingyuan' },
        { n: '广州北', e: 'Guangzhoubei' },
        { n: '广州南', e: 'Guangzhounan', major: true },
        { n: '深圳北', e: 'Shenzhenbei', major: true },
        { n: '福田', e: 'Futian', major: true },
        { n: '香港西九龙', e: 'Xianggangxijiulong', major: true }
      ]
    },
    {
      name: '京哈高铁（四纵）',
      stations: [
        { n: '北京朝阳', e: 'Beijingchaoyang', major: true },
        { n: '顺义西', e: 'Shunyixi' },
        { n: '怀柔南', e: 'Huarounan' },
        { n: '密云东', e: 'Miyundong' },
        { n: '兴隆县西', e: 'Xinglongxianxi' },
        { n: '承德南', e: 'Chengdenan' },
        { n: '承德县北', e: 'Chengdexianbei' },
        { n: '平泉北', e: 'Pingquanbei' },
        { n: '牛河梁', e: 'Niuheliang' },
        { n: '喀左', e: 'Kazuo' },
        { n: '奈林皋', e: "Nailin'gao" },
        { n: '朝阳', e: 'Chaoyang' },
        { n: '北票', e: 'Beipiao' },
        { n: '阜新', e: 'Fuxin' },
        { n: '黑山北', e: 'Heishanbei' },
        { n: '新民北', e: 'Xinminbei' },
        { n: '沈阳西', e: 'Shenyangxi' },
        { n: '沈阳北', e: 'Shenyangbei', major: true },
        { n: '铁岭西', e: 'Tielingxi' },
        { n: '开原西', e: 'Kaiyuanxi' },
        { n: '昌图西', e: 'Changtuxi' },
        { n: '四平东', e: 'Sipingdong' },
        { n: '公主岭南', e: 'Gongzhulingnan' },
        { n: '长春西', e: 'Changchunxi', major: true },
        { n: '德惠西', e: 'Dehuixi' },
        { n: '扶余北', e: 'Fuyubei' },
        { n: '双城北', e: 'Shuangchengbei' },
        { n: '哈尔滨西', e: 'Haerbinxi', major: true },
        { n: '哈尔滨', e: 'Haerbin', major: true }
      ]
    },
    {
      name: '杭深铁路（四纵）',
      stations: [
        { n: '杭州东', e: 'Hangzhoudong', major: true },
        { n: '杭州南', e: 'Hangzhounan', major: true },
        { n: '绍兴北', e: 'Shaoxingbei' },
        { n: '绍兴东', e: 'Shaoxingdong' },
        { n: '余姚北', e: 'Yuyaobei' },
        { n: '庄桥', e: 'Zhuangqiao' },
        { n: '宁波', e: 'Ningbo', major: true },
        { n: '宁波东', e: 'Ningbodong' },
        { n: '奉化', e: 'Fenghua' },
        { n: '宁海', e: 'Ninghai' },
        { n: '三门县', e: 'Sanmenxian' },
        { n: '临海', e: 'Linhai' },
        { n: '台州西', e: 'Taizhouxi' },
        { n: '温岭', e: 'Wenling' },
        { n: '雁荡山', e: 'Yandangshan' },
        { n: '乐清东', e: 'Yueqingdong' },
        { n: '乐清', e: 'Yueqing' },
        { n: '温州北', e: 'Wenzhoubei' },
        { n: '温州南', e: 'Wenzhounan', major: true },
        { n: '瑞安', e: "Rui'an" },
        { n: '平阳', e: 'Pingyang' },
        { n: '苍南', e: 'Cangnan' },
        { n: '福鼎', e: 'Fuding' },
        { n: '太姥山', e: 'Taimushan' },
        { n: '霞浦', e: 'Xiapu' },
        { n: '福安', e: "Fu'an" },
        { n: '宁德', e: 'Ningde' },
        { n: '罗源', e: 'Luoyuan' },
        { n: '连江', e: 'Lianjiang' },
        { n: '福州南', e: 'Fuzhounan', major: true },
        { n: '福清', e: 'Fuqing' },
        { n: '涵江', e: 'Hanjiang' },
        { n: '莆田', e: 'Putian' },
        { n: '仙游', e: 'Xianyou' },
        { n: '惠安', e: "Hui'an" },
        { n: '泉州', e: 'Quanzhou' },
        { n: '晋江', e: 'Jinjiang' },
        { n: '厦门北', e: 'Xiamenbei', major: true },
        { n: '漳州', e: 'Zhangzhou' },
        { n: '漳浦', e: 'Zhangpu' },
        { n: '云霄', e: 'Yunxiao' },
        { n: '诏安', e: "Zhao'an" },
        { n: '饶平', e: 'Raoping' },
        { n: '潮汕', e: 'Chaoshan', major: true },
        { n: '潮阳', e: 'Chaoyang' },
        { n: '普宁', e: 'Puning' },
        { n: '葵潭', e: 'Kuitan' },
        { n: '陆丰', e: 'Lufeng' },
        { n: '汕尾', e: 'Shanwei' },
        { n: '鲘门', e: 'Houmen' },
        { n: '惠东', e: 'Huidong' },
        { n: '惠州南', e: 'Huizhounan' },
        { n: '深圳坪山', e: 'Shenzhenpingshan' },
        { n: '深圳北', e: 'Shenzhenbei', major: true }
      ]
    },
    {
      name: '青太客专（四横）',
      stations: [
        { n: '青岛北', e: 'Qingdaobei', major: true },
        { n: '红岛', e: 'Hongdao' },
        { n: '青岛机场', e: 'Qingdaojichang' },
        { n: '胶州北', e: 'Jiaozhoubei' },
        { n: '高密北', e: 'Gaomibei' },
        { n: '潍坊北', e: 'Weifangbei' },
        { n: '青州市北', e: 'Qingzhoushibei' },
        { n: '临淄北', e: 'Linzibei' },
        { n: '淄博北', e: 'Zibobei' },
        { n: '邹平', e: 'Zouping' },
        { n: '章丘北', e: 'Zhangqiubei' },
        { n: '济南东', e: 'Jinandong', major: true },
        { n: '齐河', e: 'Qihe' },
        { n: '禹城东', e: 'Yuchengdong' },
        { n: '平原东', e: 'Pingyuandong' },
        { n: '德州东', e: 'Dezhoudong' },
        { n: '景州', e: 'Jingzhou' },
        { n: '衡水北', e: 'Hengshuibei' },
        { n: '辛集南', e: 'Xinjinan' },
        { n: '藁城南', e: 'Gaochengnan' },
        { n: '石家庄东', e: 'Shijiazhuangdong' },
        { n: '石家庄', e: 'Shijiazhuang', major: true },
        { n: '阳泉北', e: 'Yangquanbei' },
        { n: '太原南', e: 'Taiyuannan', major: true }
      ]
    },
    {
      name: '徐兰客专（四横）',
      stations: [
        { n: '徐州东', e: 'Xuzhoudong', major: true },
        { n: '萧县北', e: 'Xiaoxianbei' },
        { n: '永城北', e: 'Yongchengbei' },
        { n: '砀山南', e: 'Dangshannan' },
        { n: '商丘', e: 'Shangqiu', major: true },
        { n: '民权北', e: 'Minquanbei' },
        { n: '兰考南', e: 'Lankaonan' },
        { n: '开封北', e: 'Kaifengbei' },
        { n: '郑州东', e: 'Zhengzhoudong', major: true },
        { n: '郑州西', e: 'Zhengzhouxi' },
        { n: '巩义南', e: 'Gongyinan' },
        { n: '洛阳龙门', e: 'Luoyanglongmen', major: true },
        { n: '渑池南', e: 'Mianchinan' },
        { n: '三门峡南', e: 'Sanmenxianan' },
        { n: '灵宝西', e: 'Lingbaoxi' },
        { n: '华山北', e: 'Huashanbei' },
        { n: '渭南北', e: 'Weinanbei' },
        { n: '西安北', e: 'Xianbei', major: true },
        { n: '咸阳西', e: 'Xianyangxi' },
        { n: '杨陵南', e: 'Yanglingnan' },
        { n: '岐山', e: 'Qishan' },
        { n: '宝鸡南', e: 'Baojinan', major: true },
        { n: '东岔', e: 'Dongcha' },
        { n: '天水南', e: 'Tianshuinan' },
        { n: '秦安', e: "Qin'an" },
        { n: '通渭', e: 'Tongwei' },
        { n: '定西北', e: 'Dingxibei' },
        { n: '榆中', e: 'Yuzhong' },
        { n: '兰州西', e: 'Lanzhouxi', major: true }
      ]
    },
    {
      name: '沪汉蓉快速通道（四横）',
      stations: [
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true },
        { n: '昆山南', e: 'Kunshannan' },
        { n: '苏州', e: 'Suzhou', major: true },
        { n: '无锡', e: 'Wuxi', major: true },
        { n: '常州', e: 'Changzhou', major: true },
        { n: '丹阳', e: 'Danyang' },
        { n: '镇江', e: 'Zhenjiang' },
        { n: '南京南', e: 'Nanjingnan', major: true },
        { n: '全椒', e: 'Quanjiao' },
        { n: '合肥南', e: 'Hefeinan', major: true },
        { n: '六安', e: "Lu'an" },
        { n: '麻城北', e: 'Machengbei' },
        { n: '红安西', e: "Hong'anxi" },
        { n: '汉口', e: 'Hankou', major: true },
        { n: '汉川', e: 'Hanchuan' },
        { n: '天门南', e: 'Tiannannan' },
        { n: '仙桃西', e: 'Xiantaoxi' },
        { n: '潜江', e: 'Qianjiang' },
        { n: '荆州', e: 'Jingzhou' },
        { n: '宜昌东', e: 'Yichangdong', major: true },
        { n: '恩施', e: 'Enshi' },
        { n: '利川', e: 'Lichuan' },
        { n: '石柱县', e: 'Shizhuxian' },
        { n: '丰都', e: 'Fengdu' },
        { n: '涪陵北', e: 'Fulingbei' },
        { n: '长寿北', e: 'Changshoubei' },
        { n: '重庆北', e: 'Chongqingbei', major: true },
        { n: '合川', e: 'Hechuan' },
        { n: '潼南', e: 'Tongnan' },
        { n: '遂宁', e: 'Suining' },
        { n: '成都东', e: 'Chengdudong', major: true }
      ]
    },
    {
      name: '沪昆高铁（四横）',
      stations: [
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true },
        { n: '松江南', e: 'Songjiangnan' },
        { n: '金山北', e: 'Jinshanbei' },
        { n: '嘉善南', e: 'Jiashannan' },
        { n: '嘉兴南', e: 'Jiaxingnan' },
        { n: '桐乡', e: 'Tongxiang' },
        { n: '海宁西', e: 'Hainingxi' },
        { n: '临平南', e: 'Linpingnan' },
        { n: '杭州东', e: 'Hangzhoudong', major: true },
        { n: '杭州南', e: 'Hangzhounan', major: true },
        { n: '诸暨', e: 'Zhuji' },
        { n: '义乌', e: 'Yiwu' },
        { n: '金华', e: 'Jinhua' },
        { n: '龙游', e: 'Longyou' },
        { n: '衢州', e: 'Quzhou' },
        { n: '江山', e: 'Jiangshan' },
        { n: '玉山南', e: 'Yushannan' },
        { n: '上饶', e: 'Shangrao', major: true },
        { n: '弋阳', e: 'Yiyang' },
        { n: '鹰潭北', e: 'Yingtanbei' },
        { n: '抚州东', e: 'Fuzhoudong' },
        { n: '进贤南', e: "Jinxian'nan" },
        { n: '南昌西', e: 'Nanchangxi', major: true },
        { n: '高安', e: "Gao'an" },
        { n: '新余北', e: 'Xinyubei' },
        { n: '宜春西', e: 'Yichunxi' },
        { n: '萍乡北', e: 'Pingxiangbei' },
        { n: '醴陵东', e: 'Lilingdong' },
        { n: '长沙南', e: 'Changshanan', major: true },
        { n: '湘潭北', e: 'Xiangtanbei' },
        { n: '韶山南', e: 'Shaoshannan' },
        { n: '娄底南', e: 'Loudinan' },
        { n: '邵阳北', e: 'Shaoyangbei' },
        { n: '新化南', e: 'Xinhuanan' },
        { n: '溆浦南', e: 'Xupunan' },
        { n: '怀化南', e: 'Huaihuanan', major: true },
        { n: '芷江', e: 'Zhijiang' },
        { n: '新晃西', e: 'Xinhuangxi' },
        { n: '玉屏东', e: 'Yupingdong' },
        { n: '三穗', e: 'Sansui' },
        { n: '凯里南', e: 'Kailinan' },
        { n: '贵定北', e: 'Guidingbei' },
        { n: '贵阳东', e: 'Guiyangdong', major: true },
        { n: '贵阳北', e: 'Guiyangbei', major: true },
        { n: '平坝南', e: 'Pingbanan' },
        { n: '安顺西', e: 'Anshunxi' },
        { n: '关岭', e: 'Guanling' },
        { n: '普安', e: "Pu'an" },
        { n: '盘州', e: 'Panzhou' },
        { n: '富源北', e: 'Fuyuanbei' },
        { n: '曲靖北', e: 'Qujingbei' },
        { n: '嵩明', e: 'Songming' },
        { n: '昆明南', e: 'Kunmingnan', major: true }
      ]
    }
  ];

  /** 数据修复迁移：早期版本号码分配存在类型不匹配缺陷（号码可能重复），
      版本升级时对重复号码的车站重新分配唯一号码，并同步车次/线路站序引用。 */
  function fixDuplicateStationNos() {
    var stations = Domain.listStations();
    var byNo = {};
    stations.forEach(function (s) { (byNo[s.no] = byNo[s.no] || []).push(s); });
    Object.keys(byNo).forEach(function (no) {
      var group = byNo[no];
      for (var i = 1; i < group.length; i++) {
        Domain.reassignStationNo(group[i]);
      }
    });
    Domain.rebuildSeqPools();
  }

  /**
   * 种子化内置车站与线路（upsert 语义，按 SEED_VERSION 触发）：
   * - 车站按中文名去重复用（跨线路共享同一车站实体）；
   * - 同名线路更新站序与大站标记；新线路追加；不再存在的内置线路在未被车次引用时移除。
   */
  function seedBuiltinIfEmpty() {
    if (Storage.read(Storage.KEYS.seeded, null) === SEED_VERSION) return;

    fixDuplicateStationNos();

    var stations = Domain.listStations();
    var nameToNo = {};
    stations.forEach(function (s) { nameToNo[s.nameZh] = s.no; });

    var lineNames = {};
    BUILTIN_LINES.forEach(function (bl) { lineNames[bl.name] = true; });

    BUILTIN_LINES.forEach(function (bl) {
      var seq = [], majors = [];
      bl.stations.forEach(function (s) {
        var no = nameToNo[s.n];
        if (!no) {
          var res = Domain.addStation(s.n, s.e);
          if (!res.ok) {
            // 重名等情况下自愈：复用既有同名车站，仍失败才跳过
            var ex = Domain.listStations().find(function (x) { return x.nameZh === s.n; });
            if (!ex) return;
            no = ex.no;
          } else {
            no = res.station.no;
          }
          nameToNo[s.n] = no;
        }
        seq.push(no);
        if (s.major) majors.push(no);
      });
      if (seq.length < 2) return;

      var lines = Domain.listLines();
      var existing = lines.find(function (l) { return l.name === bl.name; });
      if (existing) {
        existing.stationSeq = seq;
        existing.majorNos = majors;
        existing.builtin = true;
        Storage.write(Storage.KEYS.lines, lines);
      } else {
        Domain.addLine(bl.name, seq, majors, { builtin: true });
      }
    });

    // 移除新版数据中不存在且未被车次引用的旧内置线路
    Domain.listLines().forEach(function (l) {
      if (l.builtin && !lineNames[l.name] && !Domain.lineUsedByTrain(l.id)) {
        Domain.removeLine(l.id);
      }
    });

    Domain.rebuildSeqPools();
    Storage.write(Storage.KEYS.seeded, SEED_VERSION);
  }

  global.Builtin = {
    LINES: BUILTIN_LINES,
    SEED_VERSION: SEED_VERSION,
    seedBuiltinIfEmpty: seedBuiltinIfEmpty
  };
})(window);
