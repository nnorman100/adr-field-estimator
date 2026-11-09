project_id  = "dryscope"
region      = "us-central1"
environment = "test"

# Dedicated 1 vCPU, 3.75 GiB, zonal: the same small tier as live, with a smaller disk.
sql_tier                  = "db-custom-1-3840"
sql_disk_size_gb          = 10
sql_backup_retained_count = 7
sql_pitr_log_days         = 3

evidence_soft_delete_days = 7
