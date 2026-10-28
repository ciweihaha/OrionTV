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
    setAggFilters,
    clearAggFilters,
    filtersVisible,
    toggleFilters,
    setFiltersVisible,
    refreshPlayRecords,
    clearError,
  } = useHomeStore();
  const { isLoggedIn, logout } = useAuthStore();
  const apiConfigStatus = useApiConfig();

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

  // CMS 筛选：UI 只转发给 store，不持有业务状态（筛选不走本地状态，见方案第 3 节）。
  // 选项的 v（不是 n）才是 agg 参数值，“全部/默认”的 v 为空串，点它等于清空该组。
  const isCmsCategory = !!selectedCategory?.cmsType;
  // 1.4.1：筛选栏是否渲染只由开关决定，与筛选值、选项、回落无关。
  // 默认 false（隐藏），切换分类时 store 已重置为 false。
  const isFilterExpanded = isCmsCategory && filtersVisible;
  const activeFilters = selectedCategory?.filters || EMPTY_AGG_FILTERS;
  const isFiltered = Object.values(activeFilters).some((v) => !!v);
  const handleFilterSelect = (key: AggFilterGroup["key"], value: string) => {
    setAggFilters({ [key]: value } as Partial<typeof activeFilters>);
  };

  // 1.4.1 焦点说明：筛选选项不再带 hasTVPreferredFocus。1.4.0 里第一组首项
  // 自动抢焦点，在开关控制下会变成“每次展开都强行跳到首项”，且展开后用户
  // 难以回到开关收起。改为空间导航：焦点停在开关上，按下方向键自然进入
  // 筛选排，再按下进入内容网格；选值只改 isSelected，不移动焦点。
  const renderFilterGroup = ({ item: group }: { item: AggFilterGroup }) => (
    <View style={dynamicStyles.filterRow}>
      <ThemedText style={dynamicStyles.filterGroupName}>{group.name}</ThemedText>
      <FlatList
        data={group.value}
        renderItem={({ item }) => {
          const isSelected = (activeFilters[group.key] || "") === item.v;
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
      />
    </View>
  );

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

      {/* 1.4.1 筛选开关：仅 CMS 分类渲染，紧贴分类排下方，一行紧凑高度。
          开关本身始终挂载（展开/收起都不卸载），是收起后的焦点落点：
          展开时焦点停在开关上，按下进入筛选排；收起时筛选排卸载，焦点
          回到开关，从开关上按一下进入分类排、下按进入内容网格首项。
          非 CMS 分类（热门剧集、豆瓣 Top250、最近播放）不渲染开关、不出筛选。
          开关不带 hasTVPreferredFocus：不抢分类排的焦点，不在切换分类时跳焦点。
          收起时若已有筛选，文案带“已选”提示，避免隐藏的筛选被遗忘；
          展开时文案为“收起”，选值、重置均不自动收起。 */}
      {isCmsCategory && (
        <View style={dynamicStyles.filterToggleRow}>
          <StyledButton
            text={filtersVisible ? "收起 ▴" : isFiltered ? "筛选 • 已选 ▾" : "筛选 ▾"}
            onPress={() => toggleFilters()}
            isSelected={filtersVisible}
            style={dynamicStyles.categoryButton}
            textStyle={dynamicStyles.categoryText}
            variant="ghost"
          />
          {selectedCategory?.cmsFallback && (
            <ThemedText style={dynamicStyles.categoryText}>已回落豆瓣</ThemedText>
          )}
        </View>
      )}

      {/* CMS 筛选栏：仅开关展开时渲染，收起时完全不占高度（条件渲染，不是用
          高度/透明度藏起来），内容网格直接顶上来可见。首屏未返回选项前，
          即使已展开也不渲染空栏占位，选项返回后才出现（loadMoreData 把 agg
          的 filters 存入 filterOptions）。选值、重置均不收起，可连选多组。 */}
      {isFilterExpanded && selectedCategory.filterOptions && selectedCategory.filterOptions.length > 0 && (
        <View>
          <FlatList
            data={selectedCategory.filterOptions}
            renderItem={renderFilterGroup}
            keyExtractor={(item) => item.key}
            showsVerticalScrollIndicator={false}
          />
          <View style={dynamicStyles.filterRow}>
            <StyledButton
              text="重置筛选"
              onPress={() => clearAggFilters()}
              style={dynamicStyles.categoryButton}
              textStyle={dynamicStyles.categoryText}
              variant="ghost"
            />
            {selectedCategory.cmsFallback && (
              <ThemedText style={dynamicStyles.categoryText}>已回落豆瓣</ThemedText>
            )}
          </View>
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
