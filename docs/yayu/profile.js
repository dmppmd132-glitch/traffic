// Yayu 版設定：台北 / 新北的公車、捷運輕軌，加上台鐵（台鐵全台共用）
// 換主題只要改 theme：'pig'（小豬）或 'bunny'（兔子），並同步換 busEmoji 與 manifest 圖示
window.TRA_PROFILE = {
  id: 'yayu',
  prefix: 'yayu.',          // localStorage 前綴，避免與一般版的常用路線混在一起
  root: '../',              // 相對於此版入口，共用檔案（sw.js 等）所在位置
  theme: 'pig',
  clearOnFocus: true,       // 車站輸入框點進去會先清空，下拉選單才會列出全部車站
  busEmoji: '🐷',            // 地圖上的公車圖示（兔子版可改 🐰）
  cities: [
    { id: 'Taipei', name: '台北', center: [25.0478, 121.5170] },
    { id: 'NewTaipei', name: '新北', center: [25.0120, 121.4650] },
  ],
  metroOps: { TRTC: '台北捷運', NTMC: '新北捷運', NTDLRT: '淡海輕軌', NTALRT: '安坑輕軌' },
};
document.documentElement.setAttribute('data-theme', window.TRA_PROFILE.theme);
