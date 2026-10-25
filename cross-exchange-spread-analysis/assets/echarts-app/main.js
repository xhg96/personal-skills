import * as echarts from "echarts";
import echartsRaw from "echarts/dist/echarts.min.js?raw";
import appSource from "./app.js?raw";

window.echarts = echarts;
await import("./app.js");
window.App.init({ appSource, echartsRaw });
