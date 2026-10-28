import { create } from "zustand";
import { api, SearchResult, PlayRecord } from "@/services/api";
import type { AggFilters, AggFilterGroup, AggVideoItem } from "@/services/api";
import { EMPTY_AGG_FILTERS } from "@/services/api";
import { PlayRecordManager } from "@/services/storage";
import useAuthStore from "./authStore";
import { useSettingsStore } from "./settingsStore";

// AggFilters / AggFilterGroup 的唯一定义在 services/api.ts，
// 这里只做类型再导出，供 app/index.tsx 直接从 homeStore 引用，避免循环导入。
export type { AggFilters, AggFilterGroup };
export { EMPTY_AGG_FILTERS };

export type RowItem = (SearchResult | PlayRecord) & {
  id: string;
  source: string;
  title: string;
  poster: string;
  progress?: number;
  play_time?: number;
  lastPlayed?: number;
  episodeIndex?: number;
  sourceName?: string;
  totalEpisodes?: number;
  year?: string;
  rate?: string;
};

export interface Category {
  title: string;
  type?: "movie" | "tv" | "record";
  tag?: string;
  tags?: string[];
  // 仅 CMS 分类用；不填 = 豆瓣模式（现有行为不变）。
  // cmsType 与 tag/tags 互斥：进入 CMS 分类时 tag 不再生效，
  // 回到豆瓣分类时 filters 不再生效（见 selectCategory 的切换处理）。
  cmsType?: 1 | 2 | 3 | 4; // agg 的 t：1 电影、2 电视剧、3 动漫、4 综艺
  filters?: AggFilters; // 当前筛选，全空 = 不筛选
  filterOptions?: AggFilterGroup[]; // agg 返回的 filters，原样存入，供 UI 渲染，不得硬编码
  cmsFallback?: boolean; // 本次是否已回落到豆瓣（仅用于 UI 提示，不进缓存 key）
}

const initialCategories: Category[] = [
  { title: "最近播放", type: "record" },
  { title: "热门剧集", type: "tv", tag: "热门" },
  { title: "电视剧", type: "tv", tags: ["国产剧", "美剧", "英剧", "韩剧", "日剧", "港剧", "日本动画", "动画"], cmsType: 2, filters: { ...EMPTY_AGG_FILTERS } },
  {
    title: "电影",
    type: "movie",
    tags: [
      "热门",
      "最新",
      "经典",
      "豆瓣高分",
      "冷门佳片",
      "华语",
      "欧美",
      "韩国",
      "日本",
      "动作",
      "喜剧",
      "爱情",
      "科幻",
      "悬疑",
      "恐怖",
    ],
    cmsType: 1,
    filters: { ...EMPTY_AGG_FILTERS },
  },
  { title: "动漫", type: "tv", cmsType: 3, filters: { ...EMPTY_AGG_FILTERS } },
  { title: "综艺", type: "tv", cmsType: 4, filters: { ...EMPTY_AGG_FILTERS } },
  { title: "豆瓣 Top250", type: "movie", tag: "top250" },
];

// CMS 回落用的豆瓣 tag：agg 失败或无筛选空列表时用它回落豆瓣，
// 不清空用户筛选、不写 CMS 缓存。电影/电视剧的回落 tag 与其 tags[0] 一致，
// 动漫/综艺在 CMS 化后已无 tags/tag，故用这张固定映射表，不得再从 tags 里猜。
const getCmsFallbackTag = (category: Category): string => {
  switch (category.title) {
    case "电影":
      return "热门";
    case "电视剧":
      return "国产剧";
    case "动漫":
      return "日本动画";
    case "综艺":
      return "综艺";
    default:
      return category.tags?.[0] || category.tag || "热门";
  }
};

// agg 项 -> RowItem（在 homeStore 做映射，不在 api.ts 混入 UI 类型）。
// source 保留 "agg"：VideoCard 点进详情时走 title 搜索，
// detailStore 已实测：preferredSource 失败/回 0 时会自动回落全量标题搜索，
// 因此本次不动 detailStore。若未来 detailStore 改掉回落，再改用 source 置空。
const mapAggItem = (item: AggVideoItem): RowItem => {
  return {
    id: item.vod_id,
    source: "agg",
    title: item.vod_name,
    poster: item.vod_pic || "",
    year: item.vod_year || "",
    rate: item.vod_douban_score && item.vod_douban_score !== "0.0" ? item.vod_douban_score : "",
    sourceName: item.type_name || "",
  } as unknown as RowItem;
};

// 添加缓存项接口
interface CacheItem {
  data: RowItem[];
  timestamp: number;
  type: 'movie' | 'tv' | 'record';
  hasMore: boolean;
  // 仅 CMS 分支用：翻页时从缓存页数继续，不得把缓存的 40 条当成“已加载全部”。
  pagecount?: number;
  aggPage?: number;
}

const CACHE_EXPIRE_TIME = 5 * 60 * 1000; // 5分钟过期
const MAX_CACHE_SIZE = 10; // 最大缓存容量
const MAX_ITEMS_PER_CACHE = 40; // 每个缓存最大条目数

const getCacheKey = (category: Category) => {
  if (category.cmsType) {
    const f = category.filters || EMPTY_AGG_FILTERS;
    return `cms-${category.cmsType}-${category.title}-c=${f.cate}|a=${f.area}|y=${f.year}|l=${f.lang}|s=${f.score}|o=${f.order}`;
  }
  return `${category.type || 'unknown'}-${category.title}-${category.tag || ''}`;
};

// filterOptions / cmsFallback 不进缓存 key：前者是 UI 选项，后者是过程标志，
// 否则同一筛选组合会因选项/回落状态不同而反复失效。

const isValidCache = (cacheItem: CacheItem) => {
  return Date.now() - cacheItem.timestamp < CACHE_EXPIRE_TIME;
};

interface HomeState {
  categories: Category[];
  selectedCategory: Category;
  contentData: RowItem[];
  loading: boolean;
  loadingMore: boolean;
  pageStart: number;
  // agg 分页专用：1-based 页码，首屏未加载为 0；不得复用豆瓣的 pageStart（offset 语义）。
  aggPage: number;
  hasMore: boolean;
  error: string | null;
  fetchInitialData: () => Promise<void>;
  loadMoreData: () => Promise<void>;
  selectCategory: (category: Category) => void;
  // CMS 筛选动作：仅当 selectedCategory.cmsType 存在时生效；
  // 语义与 selectCategory 一致（清空 + 重查），且内部直接调 fetchInitialData，
  // index.tsx 的 effect 对 CMS 模式不重复触发（见 index.tsx 注释），避免一次筛选发两次请求。
  setAggFilters: (filters: Partial<AggFilters>) => Promise<void>;
  clearAggFilters: () => Promise<void>;
  refreshPlayRecords: () => Promise<void>;
  clearError: () => void;
}

// 内存缓存，应用生命周期内有效
const dataCache = new Map<string, CacheItem>();

const useHomeStore = create<HomeState>((set, get) => ({
  categories: initialCategories,
  selectedCategory: initialCategories[0],
  contentData: [],
  loading: true,
  loadingMore: false,
  pageStart: 0,
  aggPage: 0,
  hasMore: true,
  error: null,

  fetchInitialData: async () => {
    const { apiBaseUrl } = useSettingsStore.getState();
    await useAuthStore.getState().checkLoginStatus(apiBaseUrl);

    const { selectedCategory } = get();
    const cacheKey = getCacheKey(selectedCategory);

    // 最近播放不缓存，始终实时获取
    if (selectedCategory.type === 'record') {
      set({ loading: true, contentData: [], pageStart: 0, aggPage: 0, hasMore: true, error: null });
      await get().loadMoreData();
      return;
    }

    // 检查缓存
    if (dataCache.has(cacheKey) && isValidCache(dataCache.get(cacheKey)!)) {
      const cachedData = dataCache.get(cacheKey)!;
      set({
        loading: false,
        contentData: cachedData.data,
        pageStart: cachedData.data.length,
        aggPage: selectedCategory.cmsType ? (cachedData.aggPage ?? 1) : 0,
        hasMore: cachedData.hasMore,
        error: null
      });
      return;
    }

    set({ loading: true, contentData: [], pageStart: 0, aggPage: 0, hasMore: true, error: null });
    await get().loadMoreData();
  },

  loadMoreData: async () => {
    const { selectedCategory, pageStart, aggPage, loadingMore, hasMore } = get();
    if (loadingMore || !hasMore) return;

    if (selectedCategory.cmsType ? aggPage > 0 : pageStart > 0) {
      set({ loadingMore: true });
    }

    try {
      if (selectedCategory.type === "record") {
        const { isLoggedIn } = useAuthStore.getState();
        if (!isLoggedIn) {
          set({ contentData: [], hasMore: false });
          return;
        }
        const records = await PlayRecordManager.getAll();
        const rowItems = Object.entries(records)
          .map(([key, record]) => {
            const [source, id] = key.split("+");
            return {
              ...record,
              id,
              source,
              progress: record.play_time / record.total_time,
              poster: record.cover,
              sourceName: record.source_name,
              episodeIndex: record.index,
              totalEpisodes: record.total_episodes,
              lastPlayed: record.save_time,
              play_time: record.play_time,
            };
          })
          // .filter((record) => record.progress !== undefined && record.progress > 0 && record.progress < 1)
          .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));

        set({ contentData: rowItems, hasMore: false });
      } else if (selectedCategory.cmsType) {
        // CMS 分支必须放在豆瓣分支之前：CMS 分类同时残留 type 字段，
        // 判断顺序决定走哪条路；tag 在 CMS 模式下不生效（见 setAggFilters）。
        const cmsType = selectedCategory.cmsType;
        const filters = selectedCategory.filters || EMPTY_AGG_FILTERS;
        const nextPg = (get().aggPage || 0) + 1;
        const isFiltered = Object.values(filters).some((v) => !!v);

        // 回落豆瓣：仅首屏（nextPg === 1）回落；翻页失败不回落、不清空已有列表，
        // 直接抛到外层 catch 显示错误。回落不写 CMS 缓存、不清空用户筛选。
        const fallbackToDouban = async () => {
          const cat = get().selectedCategory;
          const fallbackType = cat.type === "movie" ? "movie" : "tv";
          const fallbackTag = getCmsFallbackTag(cat);
          const doubanResult = await api.getDoubanData(fallbackType, fallbackTag, 20, 0);
          const doubanItems = doubanResult.list.map((item) => ({
            ...item,
            id: item.title,
            source: "douban",
          })) as RowItem[];
          set({
            selectedCategory: { ...cat, cmsFallback: true },
            contentData: doubanItems,
            pageStart: doubanItems.length,
            aggPage: 0,
            hasMore: doubanResult.list.length !== 0,
            error: null,
          });
        };

        let result;
        try {
          result = await api.getAggCategory(cmsType, nextPg, filters);
        } catch (aggError) {
          if (nextPg === 1) {
            await fallbackToDouban();
            return;
          }
          throw aggError;
        }
        // agg 成功但无筛选却空列表 = 异常（CMS 大类按 agg 设计“宁可多不可空”），走回落；
        // 有筛选的真实空结果不回落，显示“该筛选下暂无内容”（index.tsx 的空文案）。
        if (result.list.length === 0 && !isFiltered && nextPg === 1) {
          await fallbackToDouban();
          return;
        }

        const newItems = result.list.map(mapAggItem);
        const cacheKey = getCacheKey(selectedCategory);
        const updatedCategory: Category = result.filters
          ? { ...selectedCategory, filterOptions: result.filters, cmsFallback: false }
          : selectedCategory;
        const nextHasMore = nextPg < result.pagecount;

        if (nextPg === 1) {
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }
          dataCache.set(cacheKey, {
            data: newItems.slice(0, MAX_ITEMS_PER_CACHE),
            timestamp: Date.now(),
            type: selectedCategory.type || 'tv',
            hasMore: nextHasMore,
            pagecount: result.pagecount,
            aggPage: 1,
          });
          set({
            selectedCategory: updatedCategory,
            contentData: newItems,
            pageStart: newItems.length,
            aggPage: 1,
            hasMore: nextHasMore,
          });
        } else {
          const existingCache = dataCache.get(cacheKey);
          if (existingCache && existingCache.data.length < MAX_ITEMS_PER_CACHE) {
            dataCache.set(cacheKey, {
              ...existingCache,
              data: [...existingCache.data, ...newItems].slice(0, MAX_ITEMS_PER_CACHE),
              hasMore: nextHasMore,
              pagecount: result.pagecount,
              aggPage: nextPg,
            });
          }
          set((state) => ({
            selectedCategory: updatedCategory,
            contentData: [...state.contentData, ...newItems],
            pageStart: state.pageStart + newItems.length,
            aggPage: nextPg,
            hasMore: nextHasMore,
          }));
        }
      } else if (selectedCategory.type && selectedCategory.tag) {
        const result = await api.getDoubanData(
          selectedCategory.type,
          selectedCategory.tag,
          20,
          pageStart
        );

        const newItems = result.list.map((item) => ({
          ...item,
          id: item.title,
          source: "douban",
        })) as RowItem[];

        const cacheKey = getCacheKey(selectedCategory);

        if (pageStart === 0) {
          // 清理过期缓存
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }

          // 如果缓存太大，删除最旧的项
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }

          // 限制缓存的数据条目数，但不限制显示的数据
          const cacheItems = newItems.slice(0, MAX_ITEMS_PER_CACHE);

          // 存储新缓存
          dataCache.set(cacheKey, {
            data: cacheItems,
            timestamp: Date.now(),
            type: selectedCategory.type,
            hasMore: true // 始终为 true，因为我们允许继续加载
          });

          set({
            contentData: newItems, // 使用完整的新数据
            pageStart: newItems.length,
            hasMore: result.list.length !== 0,
          });
        } else {
          // 增量加载时更新缓存
          const existingCache = dataCache.get(cacheKey);
          if (existingCache) {
            // 只有当缓存数据少于最大限制时才更新缓存
            if (existingCache.data.length < MAX_ITEMS_PER_CACHE) {
              const updatedData = [...existingCache.data, ...newItems];
              const limitedCacheData = updatedData.slice(0, MAX_ITEMS_PER_CACHE);

              dataCache.set(cacheKey, {
                ...existingCache,
                data: limitedCacheData,
                hasMore: true // 始终为 true，因为我们允许继续加载
              });
            }
          }

          // 更新状态时使用所有数据
          set((state) => ({
            contentData: [...state.contentData, ...newItems],
            pageStart: state.pageStart + newItems.length,
            hasMore: result.list.length !== 0,
          }));
        }
      } else if (selectedCategory.tags) {
        // It's a container category, do not load content, but clear current content
        set({ contentData: [], hasMore: false });
      } else {
        set({ hasMore: false });
      }
    } catch (err: any) {
      let errorMessage = "加载失败，请重试";

      if (err.message === "API_URL_NOT_SET") {
        errorMessage = "请点击右上角设置按钮，配置您的服务器地址";
      } else if (err.message === "UNAUTHORIZED") {
        // 会话超时：API 层已尝试自动重登并重试，仍失败说明重登也没成功，
        // 此时才提示用户重新登录（登录框由 restoreSession 弹出）。
        errorMessage = "认证失败，请重新登录";
      } else if (err.message.includes("Network")) {
        errorMessage = "网络连接失败，请检查网络连接";
      } else if (err.message.includes("timeout")) {
        errorMessage = "请求超时，请检查网络或服务器状态";
      } else if (err.message.includes("404")) {
        errorMessage = "服务器API路径不正确，请检查服务器配置";
      } else if (err.message.includes("500")) {
        errorMessage = "服务器内部错误，请联系管理员";
      } else if (err.message.includes("403")) {
        errorMessage = "访问被拒绝，请检查权限设置";
      }

      set({ error: errorMessage });
    } finally {
      set({ loading: false, loadingMore: false });
    }
  },

  selectCategory: (category: Category) => {
    const currentCategory = get().selectedCategory;
    const cacheKey = getCacheKey(category);
    // 切换判定加 cmsType 与 filters：CMS 分类切回豆瓣、或同一标题下筛选变化时，
    // 不能只靠 title/tag 判断，否则会残留上一模式的状态。
    const filtersChanged =
      JSON.stringify(currentCategory.filters || null) !== JSON.stringify(category.filters || null);

    if (currentCategory.title !== category.title || currentCategory.tag !== category.tag || currentCategory.cmsType !== category.cmsType || filtersChanged) {
      // 切换分类即回到该分类的初始筛选（initialCategories 里的 EMPTY），
      // 不把上一个 CMS 分类的筛选带到新分类；豆瓣分类本身不带 filters，天然清空。
      set({
        selectedCategory: category,
        contentData: [],
        pageStart: 0,
        aggPage: 0,
        hasMore: true,
        error: null
      });

      if (category.type === 'record') {
        get().fetchInitialData();
        return;
      }

      const cachedData = dataCache.get(cacheKey);
      if (cachedData && isValidCache(cachedData)) {
        set({
          contentData: cachedData.data,
          pageStart: cachedData.data.length,
          aggPage: category.cmsType ? (cachedData.aggPage ?? 1) : 0,
          hasMore: cachedData.hasMore,
          loading: false
        });
      } else {
        // 删除过期缓存
        if (cachedData) {
          dataCache.delete(cacheKey);
        }
        get().fetchInitialData();
      }
    }
  },

  setAggFilters: async (partial: Partial<AggFilters>) => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return; // 非 CMS 分类不生效，不静默改豆瓣分类
    const merged: AggFilters = { ...(cat.filters || EMPTY_AGG_FILTERS), ...partial };
    if (JSON.stringify(merged) === JSON.stringify(cat.filters || EMPTY_AGG_FILTERS)) return;
    // CMS 与豆瓣 tag 互斥：选筛选即把 tag 置空，避免 tag + 筛选双重过滤。
    // 加载唯一入口就是这里的 fetchInitialData（index.tsx 对 CMS 模式不走 effect 重复加载）。
    set({
      selectedCategory: { ...cat, filters: merged, tag: undefined, cmsFallback: false },
      contentData: [],
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
      loading: true,
    });
    await get().fetchInitialData();
  },

  clearAggFilters: async () => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return;
    if (JSON.stringify(cat.filters || EMPTY_AGG_FILTERS) === JSON.stringify(EMPTY_AGG_FILTERS)) return;
    set({
      selectedCategory: { ...cat, filters: { ...EMPTY_AGG_FILTERS }, tag: undefined, cmsFallback: false },
      contentData: [],
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
      loading: true,
    });
    await get().fetchInitialData();
  },

  refreshPlayRecords: async () => {
    const { apiBaseUrl } = useSettingsStore.getState();
    // 设置尚未加载完成（apiBaseUrl 为空）时无法判断登录态，直接跳过，
    // 避免冷启动首帧（子组件 focus 早于 loadSettings 完成）误删"最近播放"分类。
    if (!apiBaseUrl) return;
    await useAuthStore.getState().checkLoginStatus(apiBaseUrl);
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) {
      set((state) => {
        const recordCategoryExists = state.categories.some((c) => c.type === "record");
        if (recordCategoryExists) {
          const newCategories = state.categories.filter((c) => c.type !== "record");
          if (state.selectedCategory.type === "record") {
            get().selectCategory(newCategories[0] || null);
          }
          return { categories: newCategories };
        }
        return {};
      });
      return;
    }
    const records = await PlayRecordManager.getAll();
    const hasRecords = Object.keys(records).length > 0;
    set((state) => {
      const recordCategoryExists = state.categories.some((c) => c.type === "record");
      if (hasRecords && !recordCategoryExists) {
        return { categories: [initialCategories[0], ...state.categories] };
      }
      if (!hasRecords && recordCategoryExists) {
        const newCategories = state.categories.filter((c) => c.type !== "record");
        if (state.selectedCategory.type === "record") {
          get().selectCategory(newCategories[0] || null);
        }
        return { categories: newCategories };
      }
      return {};
    });

    get().fetchInitialData();
  },

  clearError: () => {
    set({ error: null });
  },
}));

export default useHomeStore;
