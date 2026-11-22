declare module 'react-native-wheel-color-picker' {
  import type * as React from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';

  export interface WheelColorPickerProps {
    color?: string;
    onColorChange?: (color: string) => void;
    onColorChangeComplete?: (color: string) => void;
    thumbSize?: number;
    sliderSize?: number;
    gapSize?: number;
    noSnap?: boolean;
    swatches?: boolean;
    swatchesLast?: boolean;
    swatchesOnly?: boolean;
    palette?: string[];
    sliderHidden?: boolean;
    shadeWheelThumb?: boolean;
    shadeSliderThumb?: boolean;
    autoResetSlider?: boolean;
    useNativeDriver?: boolean;
    useNativeLayout?: boolean;
    disabled?: boolean;
    row?: boolean;
    style?: StyleProp<ViewStyle>;
  }

  export default class WheelColorPicker extends React.Component<WheelColorPickerProps> {
    revert(): void;
  }
}
