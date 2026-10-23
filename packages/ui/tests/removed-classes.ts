// The part classes kayjs-ui components stopped setting once their recipes drew the look in utilities, held so none comes back: a part carries `data-part` instead, and only a root keeps its `kui-` class.
export const REMOVED_UI_CLASSES: readonly string[] = `
  kui-bar-list-row kui-bar-list-label kui-bar-list-value kui-bar-list-track kui-bar-list-fill kui-bar-chart-plot kui-bar-chart-grid kui-bar-chart-tick kui-bar-chart-columns kui-bar-chart-column kui-bar-chart-bar kui-bar-chart-axis kui-bar-chart-axis-label kui-bar-chart-legend kui-bar-chart-legend-item kui-bar-chart-key
  kui-scatter-chart-axis-label kui-scatter-chart-plot kui-scatter-chart-grid kui-scatter-chart-tick kui-scatter-chart-guide kui-scatter-chart-corner kui-scatter-chart-dot
  kui-contribution-month kui-contribution-cell kui-contribution-graph-months
  kui-line-chart-frame kui-line-chart-cursor kui-line-chart-dot kui-line-chart-band kui-line-chart-overlay kui-line-chart-tooltip kui-line-chart-tooltip-label kui-line-chart-tooltip-row kui-line-chart-tooltip-name kui-line-chart-tooltip-value kui-line-chart-swatch kui-line-chart-data kui-line-chart-hint kui-line-chart-legend kui-line-chart-legend-item kui-line-chart-key kui-line-chart-tooltip-total
  kui-carousel-viewport kui-carousel-slide kui-carousel-image kui-carousel-controls kui-carousel-step kui-carousel-dot kui-carousel-pause
  kui-media-gallery-stage kui-media-gallery-frame kui-media-gallery-zoom kui-media-gallery-step kui-media-gallery-counter kui-media-gallery-caption kui-media-gallery-strip kui-media-gallery-thumb kui-media-gallery-thumb-image kui-media-gallery-play kui-media-gallery-lightbox kui-media-gallery-full kui-media-gallery-close
  kui-image-cropper-stage kui-image-cropper-image kui-image-cropper-crop kui-image-cropper-grid-cols kui-image-cropper-grid-rows kui-image-cropper-handle
  kui-zoom-tools
  kui-site-favicon-img kui-site-favicon-icon kui-site-nav-toggle kui-site-nav-toggle-menu kui-site-nav-toggle-close kui-site-nav-list kui-site-nav-link kui-site-nav-icon
  kui-card-head kui-card-title kui-card-body kui-card-row-body kui-card-row-actions
  kui-badge-icon
  kui-avatar-image kui-avatar-initial
  kui-stat-value kui-stat-label
  kui-page-header-head kui-page-header-title kui-page-header-meta kui-page-header-actions kui-page-header-description kui-page-section-head kui-page-section-title
  kui-empty-state-title kui-empty-state-description kui-empty-state-actions
  kui-widget-head kui-widget-title
  kui-meter-fill
  kui-progress-fill
  kui-skeleton-block kui-skeleton-label
  kui-table kui-table-filter kui-table-filter-input kui-table-count kui-table-selection kui-table-selected kui-table-bulk kui-table-head-cell kui-table-select-cell kui-table-select-text kui-table-sort-btn kui-table-sort-icon kui-table-row kui-table-cell kui-table-cell-label kui-table-cell-body kui-table-empty-cell
  kui-tabs-list kui-tabs-tab kui-tabs-icon kui-tabs-panel
  kui-tab-nav-link
  kui-breadcrumb-list kui-breadcrumb-more kui-breadcrumb-item kui-breadcrumb-link kui-breadcrumb-text
  kui-pagination-step kui-pagination-gap kui-pagination-page
  kui-steps-list kui-steps-item kui-steps-link kui-steps-marker kui-steps-label kui-steps-state
  kui-app-header-brand kui-app-header-nav kui-app-header-end
  kui-spinner
  kui-form-field-head kui-form-field-label kui-form-field-action kui-form-field-required kui-form-field-hint kui-form-field-issues kui-form-field-issue kui-form-dialog-footer kui-form-dialog-actions
  kui-checkbox-input kui-checkbox-label kui-checkbox-hint
  kui-toggle-input kui-toggle-track kui-toggle-label
  kui-radio kui-radio-choice kui-radio-input kui-radio-label kui-radio-description
  kui-segmented-option kui-segmented-input kui-segmented-icon kui-segmented-label
  kui-rating-stars kui-rating-fill
  kui-slider-label kui-slider-input kui-slider-value
  kui-color-input-input kui-color-input-label kui-color-input-value
  kui-date-input-box kui-date-input-trigger kui-date-input-panel kui-date-input-head kui-date-input-title kui-date-input-step kui-date-input-grid kui-date-input-weekday kui-date-input-day kui-date-input-today kui-date-range-input-separator
  kui-combobox-list kui-combobox-option kui-combobox-status
  kui-multi-select-panel kui-multi-select-trigger kui-multi-select-summary kui-multi-select-chevron kui-multi-select-search kui-multi-select-bar kui-multi-select-action kui-multi-select-options kui-multi-select-option kui-multi-select-checkbox kui-multi-select-icon kui-multi-select-label kui-multi-select-empty
  kui-chip-input kui-chip-label kui-chip-icon
  kui-file-drop-input
  kui-copy-btn-text kui-copy-btn-live
  kui-confirm-delete-armed kui-confirm-delete-message
  kui-dialog-title kui-dialog-body kui-dialog-footer
  kui-menu-list kui-menu-separator kui-menu-item
  kui-hover-card-stand
  kui-side-panel-head kui-side-panel-title kui-side-panel-body kui-side-panel-footer
  kui-command-palette-search kui-command-palette-input kui-command-palette-list kui-command-palette-heading kui-command-palette-option kui-command-palette-text kui-command-palette-label kui-command-palette-snippet kui-command-palette-more kui-command-palette-group kui-command-palette-empty kui-command-palette-count
  kui-toaster-live
  kui-toast-icon kui-toast-message kui-toast-dismiss
`.trim().split(/\s+/)
