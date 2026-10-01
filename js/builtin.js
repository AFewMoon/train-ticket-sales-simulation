/* 内置数据：国家「四纵四横」客运专线线路与大/小站标记，首次运行时种子化到 localStorage。
   四纵：京沪、京广、京哈（京哈～京沈通道）、杭深（东南沿海）；
   四横：徐兰、沪昆、青太、沪汉蓉。 */
(function (global) {
  'use strict';

  var Domain = global.Domain;
  var Storage = global.Storage;

  /* 大站 major: true；未标记者为小站 */
  var BUILTIN_LINES = [
    {
      name: '京沪高铁（四纵）',
      stations: [
        { n: '北京南', e: 'Beijingnan', major: true },
        { n: '廊坊', e: 'Langfang' },
        { n: '天津南', e: 'Tianjinnan', major: true },
        { n: '沧州西', e: 'Cangzhouxi' },
        { n: '济南西', e: 'Jinanxi', major: true },
        { n: '滕州东', e: 'Tengzhoudong' },
        { n: '徐州东', e: 'Xuzhoudong', major: true },
        { n: '滁州', e: 'Chuzhou' },
        { n: '南京南', e: 'Nanjingnan', major: true },
        { n: '苏州北', e: 'Suzhoubei' },
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true }
      ]
    },
    {
      name: '京广高铁（四纵）',
      stations: [
        { n: '北京西', e: 'Beijingxi', major: true },
        { n: '保定东', e: 'Baodingdong' },
        { n: '石家庄', e: 'Shijiazhuang', major: true },
        { n: '邢台东', e: 'Xingtaidong' },
        { n: '郑州东', e: 'Zhengzhoudong', major: true },
        { n: '许昌东', e: 'Xuchangdong' },
        { n: '武汉', e: 'Wuhan', major: true },
        { n: '岳阳东', e: 'Yueyangdong' },
        { n: '长沙南', e: 'Changshanan', major: true },
        { n: '衡阳东', e: 'Hengyangdong' },
        { n: '广州南', e: 'Guangzhounan', major: true }
      ]
    },
    {
      name: '京哈高铁（四纵）',
      stations: [
        { n: '北京朝阳', e: 'Beijingchaoyang', major: true },
        { n: '唐山', e: 'Tangshan' },
        { n: '秦皇岛', e: 'Qinhuangdao' },
        { n: '沈阳北', e: 'Shenyangbei', major: true },
        { n: '四平东', e: 'Sipingdong' },
        { n: '长春', e: 'Changchun', major: true },
        { n: '哈尔滨西', e: 'Haerbinxi', major: true }
      ]
    },
    {
      name: '杭深线（四纵·东南沿海）',
      stations: [
        { n: '杭州东', e: 'Hangzhoudong', major: true },
        { n: '绍兴北', e: 'Shaoxingbei' },
        { n: '宁波', e: 'Ningbo', major: true },
        { n: '台州', e: 'Taizhou' },
        { n: '温州南', e: 'Wenzhounan', major: true },
        { n: '福鼎', e: 'Fuding' },
        { n: '福州', e: 'Fuzhou', major: true },
        { n: '泉州', e: 'Quanzhou' },
        { n: '厦门北', e: 'Xiamenbei', major: true },
        { n: '潮汕', e: 'Chaoshan' },
        { n: '深圳北', e: 'Shenzhenbei', major: true }
      ]
    },
    {
      name: '徐兰高铁（四横）',
      stations: [
        { n: '徐州东', e: 'Xuzhoudong', major: true },
        { n: '商丘', e: 'Shangqiu' },
        { n: '郑州东', e: 'Zhengzhoudong', major: true },
        { n: '洛阳龙门', e: 'Luoyanglongmen' },
        { n: '华山北', e: 'Huashanbei' },
        { n: '西安北', e: 'Xianbei', major: true },
        { n: '宝鸡南', e: 'Baojinan' },
        { n: '天水南', e: 'Tianshuinan' },
        { n: '兰州西', e: 'Lanzhouxi', major: true }
      ]
    },
    {
      name: '沪昆高铁（四横）',
      stations: [
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true },
        { n: '嘉兴南', e: 'Jiaxingnan' },
        { n: '杭州东', e: 'Hangzhoudong', major: true },
        { n: '义乌', e: 'Yiwu' },
        { n: '金华', e: 'Jinhua' },
        { n: '上饶', e: 'Shangrao' },
        { n: '南昌西', e: 'Nanchangxi', major: true },
        { n: '宜春', e: 'Yichun' },
        { n: '长沙南', e: 'Changshanan', major: true },
        { n: '娄底南', e: 'Loudinan' },
        { n: '怀化南', e: 'Huainan' },
        { n: '贵阳北', e: 'Guiyangbei', major: true },
        { n: '安顺西', e: 'Anshunxi' },
        { n: '昆明南', e: 'Kunmingnan', major: true }
      ]
    },
    {
      name: '青太客专（四横）',
      stations: [
        { n: '青岛', e: 'Qingdao', major: true },
        { n: '潍坊', e: 'Weifang' },
        { n: '淄博', e: 'Zibo' },
        { n: '济南', e: 'Jinan', major: true },
        { n: '德州东', e: 'Dezhoudong' },
        { n: '石家庄', e: 'Shijiazhuang', major: true },
        { n: '阳泉北', e: 'Yangquanbei' },
        { n: '太原南', e: 'Taiyuannan', major: true }
      ]
    },
    {
      name: '沪汉蓉快速（四横）',
      stations: [
        { n: '上海虹桥', e: 'Shanghaihongqiao', major: true },
        { n: '苏州', e: 'Suzhou' },
        { n: '南京南', e: 'Nanjingnan', major: true },
        { n: '合肥', e: 'Hefei', major: true },
        { n: '汉口', e: 'Hankou', major: true },
        { n: '宜昌东', e: 'Yichangdong' },
        { n: '恩施', e: 'Enshi' },
        { n: '重庆北', e: 'Chongqingbei', major: true },
        { n: '成都东', e: 'Chengdong', major: true }
      ]
    }
  ];

  /** 首次运行时种子化内置车站与线路（以 tts:seeded 标记保证只执行一次） */
  function seedBuiltinIfEmpty() {
    if (Storage.read(Storage.KEYS.seeded, null) === '1') return;
    var nameToNo = {};
    var lines = [];
    BUILTIN_LINES.forEach(function (bl) {
      var seq = [], majors = [];
      bl.stations.forEach(function (s) {
        var no = nameToNo[s.n];
        if (!no) {
          var res = Domain.addStation(s.n, s.e);
          if (!res.ok) return; // 极端情况下（重名冲突）跳过该站
          no = res.station.no;
          nameToNo[s.n] = no;
        }
        seq.push(no);
        if (s.major) majors.push(no);
      });
      if (seq.length >= 2) {
        var res = Domain.addLine(bl.name, seq, majors, { builtin: true });
        if (res.ok) lines.push(res.line.name);
      }
    });
    Domain.rebuildSeqPools();
    Storage.write(Storage.KEYS.seeded, '1');
    return lines;
  }

  global.Builtin = {
    LINES: BUILTIN_LINES,
    seedBuiltinIfEmpty: seedBuiltinIfEmpty
  };
})(window);
