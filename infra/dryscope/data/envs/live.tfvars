project_id  = "dryscope"
region      = "us-central1"
environment = "live"

# Dedicated 1 vCPU, 3.75 GiB, zonal. HA is an open owner decision.
sql_tier                  = "db-custom-1-3840"
sql_disk_size_gb          = 20
sql_backup_retained_count = 14
sql_pitr_log_days         = 7

evidence_soft_delete_days = 7
