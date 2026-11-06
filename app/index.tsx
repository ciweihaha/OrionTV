import React, { useEffect, useCallback, useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator, FlatList, Pressable, Animated, StatusBar, Platform, BackHandler, ToastAndroid } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { api } from "@/services/api";
import VideoCard from "@/components/VideoCard";
import { useFocusEffect, useRouter } from "expo-router";
import { Search, Settings, LogOut, Heart } from "lucide-react-native";
import { StyledButton } from "@/components/StyledButton";
import useHomeStore, { RowItem, Category, EMPTY_AGG_FILTERS } from "@/stores/homeStore";
import type { AggFilterGroup } from "@/stores/homeStore";
import useAuthStore from "@/stores/authStore";
import CustomScrollView from "@/components/CustomScrollView";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import { useApiConfig, getApiConfigErrorMessage } from "@/hooks/useApiConfig";
import { Colors } from "@/constants/Colors";

const LOAD_MORE_THRESHOLD = 200;

export default function HomeScreen() {
  const router = useRouter();
  const colorScheme = "dark";
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const {
    categories,
    selectedCategory,
    contentData,
    loading,
    loadingMore,
    error,
    fetchInitialData,
    loadMoreData,
    selectCategory,
    clearAggFilters,
    setPendingFilter,
    clearAggFilterGroup,
    restoreFilterMemory,
    pendingFilters,
    filterServiceUnavailable,
    filtersVisible,
    toggleFilters,
    setFiltersVisible,
    refreshPlayRecords,
    clearError,
  } = useHomeStore();
  const { isLoggedIn, logout } = useAuthStore();
  const apiConfigStatus = useApiConfig();

  // 2026-11-05：冷启动先恢复按分类记忆的筛选。恢复本身不发请求，
  // 记忆要在第一次进入 CMS 分类之前就位，否则 selectCategory 会用 EMPTY 覆盖。
  useEffect(() => {
    restoreFilterMemory();
  }, [restoreFilterMemory]);

  useFocusEffect(
    useCallback(() => {
      refreshPlayRecords();
    }, [refreshPlayRecords])
  );

    // 双击返回退出逻辑（只限当前页面）
  // 1.4.1：筛选正展开时，返回键先收起筛选，不走双击退出、不弹退出提示、
  // 不直接退出分类；收起后把双击计时清零，下一次返回重新计双击。
  // 依赖 filtersVisible：可见性变化时重新注册 handler，否则闭包会一直读到旧值。
  const backPressTimeRef = useRef<number | null>(null);

  useFocusEffect(
    useCallback(() => {
    const handleBackPress = () => {
      if (filtersVisible) {
        setFiltersVisible(false);
        backPressTimeRef.current = null;
        return true; // 已消费：只收起筛选
      }

      const now = Date.now();

      // 如果还没按过返回键，或距离上次超过2秒
      if (!backPressTimeRef.current || now - backPressTimeRef.current > 2000) {
        backPressTimeRef.current = now;
        ToastAndroid.show("再按一次返回键退出", ToastAndroid.SHORT);
        return true; // 拦截返回事件，不退出
      }

      // 两次返回键间隔小于2秒，退出应用
      BackHandler.exitApp();
      return true;
    };

    // 仅限 Android 平台启用此功能
    if (Platform.OS === "android") {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleBackPress);

      // 返回首页时重置状态
      return () => {
        backHandler.remove();
        backPressTimeRef.current = null;
      };
    }
  }, [filtersVisible, setFiltersVisible])
);

  // 统一的数据获取逻辑
  // CMS 模式二选一（见 homeStore.setAggFilters 注释）：CMS 的加载唯一入口是
  // store 的 selectCategory / setAggFilters / clearAggFilters，effect 在此直接返回，
  // 不做 tag 默认、不重复调 fetchInitialData，否则一次筛选会发两次请求，
  // 且 tag 默认逻辑会把 CMS 分类拉回豆瓣；缓存命中时首屏只有 40 条，
  // effect 再拉一次还会把首屏 60 条覆盖成缓存 40 条。
  useEffect(() => {
    if (!selectedCategory) return;

    if (selectedCategory.cmsType) {
      return;
    }

    // 如果是容器分类且没有选择标签，设置默认标签
    if (selectedCategory.tags && !selectedCategory.tag) {
      const defaultTag = selectedCategory.tags[0];
      setSelectedTag(defaultTag);
      selectCategory({ ...selectedCategory, tag: defaultTag });
      return;
    }

    // 只有在API配置完成且分类有效时才获取数据
    if (apiConfigStatus.isConfigured && !apiConfigStatus.needsConfiguration) {
      // 对于有标签的分类，需要确保有标签才获取数据
      if (selectedCategory.tags && selectedCategory.tag) {
        fetchInitialData();
      }
      // 对于无标签的分类，直接获取数据
      else if (!selectedCategory.tags) {
        fetchInitialData();
      }
    }
  }, [
    selectedCategory,
    selectedCategory?.tag,
    apiConfigStatus.isConfigured,
    apiConfigStatus.needsConfiguration,
    fetchInitialData,
    selectCategory,
  ]);

  // 清除错误状态的逻辑
  useEffect(() => {
    if (apiConfigStatus.needsConfiguration && error) {
      clearError();
    }
  }, [apiConfigStatus.needsConfiguration, error, clearError]);

  useEffect(() => {
    if (!loading && contentData.length > 0) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else if (loading) {
      fadeAnim.setValue(0);
    }
  }, [loading, contentData.length, fadeAnim]);

  const handleCategorySelect = (category: Category) => {
    setSelectedTag(null);
    selectCategory(category);
  };

  const handleTagSelect = (tag: string) => {
    setSelectedTag(tag);
    if (selectedCategory) {
      const categoryWithTag = { ...selectedCategory, tag: tag };
      selectCategory(categoryWithTag);
    }
  };

  // 2026-11-06 第二轮（P1-2 方案 A）：选了即生效，草稿模型已废弃。
  // UI 只持有“更多面板是否展开”“年份年代段”这种纯展示状态，筛选业务值仍在 store。
  // 选项的 v（不是 n）才是 agg 参数值，“全部/默认”的 v 为空串，点它等于清空该组。
  // 组内点选项：setPendingFilter 立即改已选态，500ms 防抖后自动应用并重查，
  // 连选多组只发 1 次请求（见 homeStore.schedulePendingApply），不再等“应用”；
  // “应用”/“放弃修改”按钮已删除。已选 chips 展示的是已选值，点叉即清即生效。
  // 单组清除有两条路：chips 上的叉与展开面板里每组头部的“清除”，均立即生效并重查；
  // “清除全部”始终立即生效。
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [expandedYearDecade, setExpandedYearDecade] = useState<string | null>(null);
  const groupListRefs = useRef<Record<string, FlatList | null>>({});
  const isCmsCategory = !!selectedCategory?.cmsType;
  const isFilterExpanded = isCmsCategory && filtersVisible;
  const activeFilters = selectedCategory?.filters || EMPTY_AGG_FILTERS;
  // pickedFilters = 已选值（pendingFilters 与已应用值在防抖窗口内可能短暂不一致，
  // 500ms 后收敛；isSelected 与 chips 一律对照它，用户刚点的选项立即显示已选态）。
  const pickedFilters = pendingFilters || activeFilters;
  const isFiltered = Object.values(activeFilters).some((v) => !!v);
  const appliedCount = Object.values(activeFilters).filter((v) => !!v).length;
  const handleFilterSelect = (key: AggFilterGroup["key"], value: string) => {
    setPendingFilter(key, value);
  };
  const handleToggleFilters = () => {
    // 2026-11-06 方案 A：收起不丢已选值，chips 行在收起时同样渲染，已选态不会被藏起来。
    toggleFilters();
  };
  const getOptionName = (key: AggFilterGroup["key"], value: string): string => {
    if (!value) return "";
    const group = selectedCategory?.filterOptions?.find((g) => g.key === key);
    return group?.value.find((o) => o.v === value)?.n || value;
  };
  // 地区常用置顶：只改展示顺序，不改 agg 选项本身；“全部”永远在第一位。
  const COMMON_AREAS = ["大陆", "香港", "台湾", "美国", "韩国", "日本", "英国", "法国"];
  const orderAreaOptions = (group: AggFilterGroup) => {
    const all = group.value.filter((o) => o.v === "");
    const rest = group.value.filter((o) => o.v !== "");
    const ranked = rest.filter((o) => COMMON_AREAS.includes(o.n));
    ranked.sort((a, b) => COMMON_AREAS.indexOf(a.n) - COMMON_AREAS.indexOf(b.n));
    const others = rest.filter((o) => !COMMON_AREAS.includes(o.n));
    return [...all, ...ranked, ...others];
  };
  // 年份按年代段分：选项 v 为数字年份时算年代，否则归入“其他”。
  // “全部”不进年代段，单独放在年代段选择行里。
  const getYearDecade = (v: string): string | null => {
    const y = parseInt(v, 10);
    if (Number.isNaN(y)) return null;
    return `${Math.floor(y / 10) * 10}年代`;
  };
  // 已选值自动滚到可见：尽力而为，scrollToIndex 失败时不抛错、不影响筛选。
  useEffect(() => {
    if (!isFilterExpanded || !selectedCategory?.filterOptions) return;
    for (const group of selectedCategory.filterOptions) {
      const options = group.key === "area" ? orderAreaOptions(group) : group.value;
      const idx = options.findIndex((o) => o.v === (pickedFilters[group.key] || ""));
      if (idx <= 0) continue;
      const ref = groupListRefs.current[group.key];
      try {
        ref?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
      } catch {
        // 布局未就绪时忽略，下一次渲染再试。
      }
    }
    // 只在展开/选项/已选值变化时尝试滚动，不监听整个 picked 对象以外的状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFilterExpanded, selectedCategory?.filterOptions, pickedFilters]);

  // 2026-11-05 焦点说明：筛选选项仍不带 hasTVPreferredFocus（1.4.1 的
  // 教训：首项自动抢焦点会让展开后难以回到开关）。TV 端的可见焦点框
  // 来自 StyledButton 自身的 focused 样式（边框 + 背景），已选组在组名
  // 前加“✓”前缀，空间导航仍是：开关 → 筛选排 → 内容网格。
  // 方案 A：这里点选项即改已选态、防抖后自动应用；isSelected 对照已选值，
  // 不是已应用值，否则连选时已选态会来回跳。
  const renderFilterGroup = ({ item: group }: { item: AggFilterGroup }) => {
    const options = group.key === "area" ? orderAreaOptions(group) : group.value;
    const groupLabel = pickedFilters[group.key] ? `✓ ${group.name}` : group.name;
    return (
      <View style={dynamicStyles.filterRow}>
        <ThemedText style={dynamicStyles.filterGroupName}>{groupLabel}</ThemedText>
        <FlatList
          ref={(ref) => {
            groupListRefs.current[group.key] = ref;
          }}
          data={options}
          renderItem={({ item }) => {
            const isSelected = (pickedFilters[group.key] || "") === item.v;
            return (
              <StyledButton
                text={item.n}
                onPress={() => handleFilterSelect(group.key, item.v)}
                isSelected={isSelected}
                style={dynamicStyles.categoryButton}
                textStyle={dynamicStyles.categoryText}
                variant="ghost"
              />
            );
          }}
          keyExtractor={(item) => `${item.v}|${item.n}`}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={dynamicStyles.categoryListContent}
          onScrollToIndexFailed={() => {
            // 布局未就绪时忽略自动滚动，不阻塞筛选。
          }}
        />
        <StyledButton
          text="清除"
          onPress={() => clearAggFilterGroup(group.key)}
          style={dynamicStyles.categoryButton}
          textStyle={dynamicStyles.categoryText}
          variant="ghost"
        />
      </View>
    );
  };

  // 年份年代段：先选年代段，再选该段内的具体年份，避免逐年横滑到底。
  // 年代段本身不进 agg 参数，只有具体年份的 v 才是参数值。
  const renderYearGroup = (group: AggFilterGroup) => {
    const allOption = group.value.find((o) => o.v === "");
    const yearOptions = group.value.filter((o) => o.v !== "");
    const decades: string[] = [];
    for (const o of yearOptions) {
      const d = getYearDecade(o.v);
      if (d && !decades.includes(d)) decades.push(d);
    }
    decades.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    const pickedDecade = getYearDecade(pickedFilters.year || "");
    const activeDecade = expandedYearDecade || pickedDecade || decades[0] || null;
    const visibleYears = activeDecade
      ? yearOptions.filter((o) => getYearDecade(o.v) === activeDecade)
      : yearOptions;
    return (
      <View>
        <View style={dynamicStyles.filterRow}>
          <ThemedText style={dynamicStyles.filterGroupName}>
            {pickedFilters.year ? `✓ ${group.name}` : group.name}
          </ThemedText>
          <FlatList
            data={[
              ...(allOption ? [allOption] : []),
              ...decades.map((d) => ({ n: d, v: `decade:${d}` })),
            ]}
            renderItem={({ item }) => {
              const isDecade = item.v.startsWith("decade:");
              const isSelected = isDecade
                ? activeDecade === item.n
                : (pickedFilters.year || "") === item.v;
              return (
                <StyledButton
                  text={item.n}
                  onPress={() => {
                    if (isDecade) {
                      setExpandedYearDecade(item.n);
                    } else {
                      handleFilterSelect("year", item.v);
                    }
                  }}
                  isSelected={isSelected}
                  style={dynamicStyles.categoryButton}
                  textStyle={dynamicStyles.categoryText}
                  variant="ghost"
                />
              );
            }}
            keyExtractor={(item) => `${item.v}|${item.n}`}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={dynamicStyles.categoryListContent}
          />
          <StyledButton
            text="清除"
            onPress={() => clearAggFilterGroup("year")}
            style={dynamicStyles.categoryButton}
            textStyle={dynamicStyles.categoryText}
            variant="ghost"
          />
        </View>
        {activeDecade && (
          <View style={dynamicStyles.filterRow}>
            <ThemedText style={dynamicStyles.filterGroupName}>{activeDecade}</ThemedText>
            <FlatList
              data={visibleYears}
              renderItem={({ item }) => {
                const isSelected = (pickedFilters.year || "") === item.v;
                return (
                  <StyledButton
                    text={item.n}
                    onPress={() => handleFilterSelect("year", item.v)}
                    isSelected={isSelected}
                    style={dynamicStyles.categoryButton}
                    textStyle={dynamicStyles.categoryText}
                    variant="ghost"
                  />
                );
              }}
              keyExtractor={(item) => `${item.v}|${item.n}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={dynamicStyles.categoryListContent}
            />
          </View>
        )}
      </View>
    );
  };

  // 已选 chips：展示已选值，点叉即清即生效（防抖 500ms 后重查），
  // 与展开面板里每组头部的“清除”（立即生效）语义一致，见文件顶部注释。
  const renderSelectedChips = () => {
    const keys: AggFilterGroup["key"][] = ["cate", "area", "year", "lang", "score", "order"];
    const chips = keys
      .map((key) => {
        const value = pickedFilters[key] || "";
        if (!value) return null;
        const group = selectedCategory?.filterOptions?.find((g) => g.key === key);
        return { key, label: `${group?.name || key}：${getOptionName(key, value)}` };
      })
      .filter((c): c is { key: AggFilterGroup["key"]; label: string } => !!c);
    if (chips.length === 0) return null;
    return (
      <View style={dynamicStyles.filterChipRow}>
        {chips.map((chip) => (
          <StyledButton
            key={chip.key}
            text={`${chip.label} ×`}
            onPress={() => handleFilterSelect(chip.key, "")}
            isSelected
            style={dynamicStyles.categoryButton}
            textStyle={dynamicStyles.categoryText}
            variant="ghost"
          />
        ))}
        {isFiltered && (
          <StyledButton
            text="清除全部"
            onPress={() => clearAggFilters()}
            style={dynamicStyles.categoryButton}
            textStyle={dynamicStyles.categoryText}
            variant="ghost"
          />
        )}
      </View>
    );
  };

  const renderCategory = ({ item }: { item: Category }) => {
    const isSelected = selectedCategory?.title === item.title;
    return (
      <StyledButton
        text={item.title}
        onPress={() => handleCategorySelect(item)}
        isSelected={isSelected}
        style={dynamicStyles.categoryButton}
        textStyle={dynamicStyles.categoryText}
      />
    );
  };

  const renderContentItem = ({ item }: { item: RowItem; index: number }) => (
    <VideoCard
      id={item.id}
      source={item.source}
      title={item.title}
      poster={item.poster}
      year={item.year}
      rate={item.rate}
      progress={item.progress}
      playTime={item.play_time}
      episodeIndex={item.episodeIndex}
      sourceName={item.sourceName}
      totalEpisodes={item.totalEpisodes}
      api={api}
      onRecordDeleted={fetchInitialData}
    />
  );

  const renderFooter = () => {
    if (!loadingMore) return null;
    return <ActivityIndicator style={{ marginVertical: 20 }} size="large" />;
  };

  // 检查是否需要显示API配置提示
  const shouldShowApiConfig = apiConfigStatus.needsConfiguration && selectedCategory && !selectedCategory.tags;

  // TV端和平板端的顶部导航
  const renderHeader = () => {
    if (deviceType === "mobile") {
      // 移动端不显示顶部导航，使用底部Tab导航
      return null;
    }

    return (
      <View style={dynamicStyles.headerContainer}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <ThemedText style={dynamicStyles.headerTitle}>首页</ThemedText>
          <Pressable android_ripple={Platform.isTV || deviceType !== 'tv'? { color: 'transparent' } : { color: Colors.dark.link }} style={{ marginLeft: 20 }} onPress={() => router.push("/live")}>
            {({ focused }) => (
              <ThemedText style={[dynamicStyles.headerTitle, { color: focused ? "white" : "grey" }]}>直播</ThemedText>
            )}
          </Pressable>
        </View>
        <View style={dynamicStyles.rightHeaderButtons}>
          <StyledButton style={dynamicStyles.iconButton} onPress={() => router.push("/favorites")} variant="ghost">
            <Heart color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          <StyledButton
            style={dynamicStyles.iconButton}
            onPress={() => router.push({ pathname: "/search" })}
            variant="ghost"
          >
            <Search color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          <StyledButton style={dynamicStyles.iconButton} onPress={() => router.push("/settings")} variant="ghost">
            <Settings color={colorScheme === "dark" ? "white" : "black"} size={24} />
          </StyledButton>
          {isLoggedIn && (
            <StyledButton style={dynamicStyles.iconButton} onPress={logout} variant="ghost">
              <LogOut color={colorScheme === "dark" ? "white" : "black"} size={24} />
            </StyledButton>
          )}
        </View>
      </View>
    );
  };

  // 动态样式
  const dynamicStyles = StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: deviceType === "mobile" ? insets.top : deviceType === "tablet" ? insets.top + 20 : 40,
    },
    headerContainer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: spacing * 1.5,
      marginBottom: spacing,
    },
    headerTitle: {
      fontSize: deviceType === "mobile" ? 24 : deviceType === "tablet" ? 28 : 32,
      fontWeight: "bold",
      paddingTop: 16,
    },
    rightHeaderButtons: {
      flexDirection: "row",
      alignItems: "center",
    },
    iconButton: {
      borderRadius: 30,
      marginLeft: spacing / 2,
    },
    categoryContainer: {
      paddingBottom: spacing / 2,
    },
    categoryListContent: {
      paddingHorizontal: spacing,
    },
    categoryButton: {
      paddingHorizontal: deviceType === "tv" ? spacing / 4 : spacing / 2,
      paddingVertical: spacing / 2,
      borderRadius: deviceType === "mobile" ? 6 : 8,
      marginHorizontal: deviceType === "tv" ? spacing / 4 : spacing / 2, // TV端使用更小的间距
    },
    categoryText: {
      fontSize: deviceType === "mobile" ? 14 : 16,
      fontWeight: "500",
    },
    filterRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingBottom: spacing / 2,
      paddingHorizontal: spacing,
    },
    // 1.4.1 筛选开关行：一行紧凑高度，收起时筛选排不渲染，故不占筛选高度。
    filterToggleRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingBottom: spacing / 2,
      paddingHorizontal: spacing,
    },
    filterGroupName: {
      fontSize: deviceType === "mobile" ? 14 : 16,
      fontWeight: "500",
      width: 64,
    },
    // 2026-11-05：已选 chips 行（可换行，避免横滑到底）、清除行、
    // 选项骨架行。chips 行在收起和展开两种状态下都渲染，已选值不会被藏起来。
    filterChipRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      paddingBottom: spacing / 2,
      paddingHorizontal: spacing,
      gap: spacing / 2,
    },
    filterApplyRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingBottom: spacing / 2,
      paddingHorizontal: spacing,
      gap: spacing / 2,
    },
    filterSkeletonRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingBottom: spacing / 2,
      paddingHorizontal: spacing,
      gap: spacing / 2,
    },
    contentContainer: {
      flex: 1,
    },
  });

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {/* 状态栏 */}
      {deviceType === "mobile" && <StatusBar barStyle="light-content" />}

      {/* 顶部导航 */}
      {renderHeader()}

      {/* 分类选择器 */}
      <View style={dynamicStyles.categoryContainer}>
        <FlatList
          data={categories}
          renderItem={renderCategory}
          keyExtractor={(item) => item.title}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={dynamicStyles.categoryListContent}
        />
      </View>

      {/* 子分类标签：仅豆瓣模式渲染；CMS 模式下隐藏，避免 tag 与筛选双重过滤 */}
      {selectedCategory && selectedCategory.tags && !selectedCategory.cmsType && (
        <View style={dynamicStyles.categoryContainer}>
          <FlatList
            data={selectedCategory.tags}
            renderItem={({ item, index }) => {
              const isSelected = selectedTag === item;
              return (
                <StyledButton
                  hasTVPreferredFocus={index === 0}
                  text={item}
                  onPress={() => handleTagSelect(item)}
                  isSelected={isSelected}
                  style={dynamicStyles.categoryButton}
                  textStyle={dynamicStyles.categoryText}
                  variant="ghost"
                />
              );
            }}
            keyExtractor={(item) => item}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={dynamicStyles.categoryListContent}
          />
        </View>
      )}

      {/* 2026-11-05 筛选开关：仅 CMS 分类渲染。默认展开（store 默认 true，
          记忆恢复后以记忆为准），开关本身始终挂载，是收起后的焦点落点，
          TV 端不带 hasTVPreferredFocus，不抢分类排焦点。收起时不再只写
          “已选”二字，而是直接渲染已选 chips + 已选组数 + 清除全部，
          已选值不会被藏起来。 */}
      {isCmsCategory && (
        <View style={dynamicStyles.filterToggleRow}>
          <StyledButton
            text={
              filtersVisible
                ? "收起筛选"
                : isFiltered
                  ? `筛选（已选 ${appliedCount} 组）`
                  : "筛选"
            }
            onPress={handleToggleFilters}
            isSelected={filtersVisible}
            style={dynamicStyles.categoryButton}
            textStyle={dynamicStyles.categoryText}
            variant="ghost"
          />
          {selectedCategory?.cmsFallback &&
            (filterServiceUnavailable ? (
              <ThemedText style={dynamicStyles.categoryText}>
                筛选服务不可用，已显示豆瓣内容
              </ThemedText>
            ) : (
              <ThemedText style={dynamicStyles.categoryText}>已回落豆瓣</ThemedText>
            ))}
        </View>
      )}

      {/* CMS 已选 chips：收起和展开两种状态下都渲染，点叉即清即生效；
          “清除全部”始终立即生效。 */}
      {isCmsCategory && renderSelectedChips()}

      {/* CMS 筛选栏：展开时渲染，分层——第一层只放类型、年份、地区、
          排序 4 组快捷项，语言、评分收进“更多筛选”。2026-11-06 方案 A：
          组内点选项即生效（500ms 防抖合并，连选多组只发 1 次请求），
          不再等“应用”；选值、重置均不自动收起。选项未到时
          显示骨架而不是空栏；agg 失败时明确写服务不可用，不静默回落。
          2026-11-05 第 2 轮：面板顺序改为 快捷层 → 更多开关 → 更多层 →
          操作行（清除全部）在面板底部；此前操作行夹在快捷层与
          更多层中间，更多层在操作行下方，层级不清。本改动只挪 JSX 顺序，
          不新增焦点项、不抢焦点、不改任何筛选逻辑与请求逻辑；返回键路径
          不变（展开时返回先收起筛选）。 */}
      {isFilterExpanded && (
        <View>
          {!selectedCategory.filterOptions || selectedCategory.filterOptions.length === 0 ? (
            <View style={dynamicStyles.filterSkeletonRow}>
              {loading ? (
                <>
                  <ActivityIndicator size="small" />
                  <ThemedText style={dynamicStyles.categoryText}>
                    正在加载筛选选项…
                  </ThemedText>
                </>
              ) : filterServiceUnavailable ? (
                <ThemedText style={dynamicStyles.categoryText}>
                  筛选服务不可用，已显示豆瓣内容
                </ThemedText>
              ) : (
                <ThemedText style={dynamicStyles.categoryText}>暂无筛选选项</ThemedText>
              )}
            </View>
          ) : (
            <>
              <FlatList
                data={selectedCategory.filterOptions.filter((g) =>
                  ["cate", "area", "year", "order"].includes(g.key)
                )}
                renderItem={({ item }) =>
                  item.key === "year" ? renderYearGroup(item) : renderFilterGroup({ item })
                }
                keyExtractor={(item) => item.key}
                showsVerticalScrollIndicator={false}
              />
              <View style={dynamicStyles.filterApplyRow}>
                <StyledButton
                  text={showMoreFilters ? "收起更多筛选" : "更多筛选"}
                  onPress={() => setShowMoreFilters(!showMoreFilters)}
                  isSelected={showMoreFilters}
                  style={dynamicStyles.categoryButton}
                  textStyle={dynamicStyles.categoryText}
                  variant="ghost"
                />
              </View>
              {showMoreFilters && (
                <FlatList
                  data={selectedCategory.filterOptions.filter((g) =>
                    ["lang", "score"].includes(g.key)
                  )}
                  renderItem={renderFilterGroup}
                  keyExtractor={(item) => item.key}
                  showsVerticalScrollIndicator={false}
                />
              )}
              {selectedCategory.cmsFallback &&
                (filterServiceUnavailable ? (
                  <ThemedText style={dynamicStyles.categoryText}>
                    筛选服务不可用，已显示豆瓣内容
                  </ThemedText>
                ) : (
                  <ThemedText style={dynamicStyles.categoryText}>已回落豆瓣</ThemedText>
                ))}
              {/* 面板底部操作行：2026-11-06 方案 A 已删“应用/放弃修改”，
                  点选项即生效，只剩“清除全部”。 */}
              <View style={dynamicStyles.filterApplyRow}>
                <StyledButton
                  text="清除全部"
                  onPress={() => clearAggFilters()}
                  style={dynamicStyles.categoryButton}
                  textStyle={dynamicStyles.categoryText}
                  variant="ghost"
                />
              </View>
            </>
          )}
        </View>
      )}

      {/* 内容网格 */}
      {shouldShowApiConfig ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            {getApiConfigErrorMessage(apiConfigStatus)}
          </ThemedText>
        </View>
      ) : apiConfigStatus.isValidating ? (
        <View style={commonStyles.center}>
          <ActivityIndicator size="large" />
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            正在验证服务器配置...
          </ThemedText>
        </View>
      ) : apiConfigStatus.error && !apiConfigStatus.isValid ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing, textAlign: "center" }}>
            {apiConfigStatus.error}
          </ThemedText>
        </View>
      ) : loading ? (
        <View style={commonStyles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={commonStyles.center}>
          <ThemedText type="subtitle" style={{ padding: spacing }}>
            {error}
          </ThemedText>
        </View>
      ) : (
        <Animated.View style={[dynamicStyles.contentContainer, { opacity: fadeAnim }]}>
          <CustomScrollView
            data={contentData}
            renderItem={renderContentItem}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            onEndReached={loadMoreData}
            loadMoreThreshold={LOAD_MORE_THRESHOLD}
            emptyMessage={isCmsCategory ? (isFiltered ? "该筛选下暂无内容" : "该分类下暂无内容") : (selectedCategory?.tags ? "请选择一个子分类" : "该分类下暂无内容")}
            ListFooterComponent={renderFooter}
          />
        </Animated.View>
      )}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === "tv") {
    return content;
  }

  return <ResponsiveNavigation>{content}</ResponsiveNavigation>;
}
